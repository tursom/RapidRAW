//! Explicit URL acquisition, not recovery of bytes previously downloaded by a browser.
//!
//! Call only after the GUI's explicit button action, on `spawn_blocking`. This module
//! performs no clipboard access, disk writes, logging, or IPC of image data. RGBA8
//! describes the fully decoded default image (first frame/page for animated or
//! multipage formats), without applying EXIF orientation or color management.

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use reqwest::blocking::Client;
use reqwest::header::{CONTENT_ENCODING, CONTENT_TYPE, LOCATION};
use reqwest::{Url, redirect::Policy};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use std::time::{Duration, Instant};

const MAX_ENCODED_BYTES: usize = 128 * 1024 * 1024;
// Decimal megapixels, not mebipixels.
const MAX_PIXELS: u64 = 64_000_000;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Fetch and validate a newly requested image, returning only a redacted summary.
///
/// `sha256` hashes the HTTP entity body exactly as received, with content decoding
/// disabled. `rgba8Sha256` hashes row-major RGBA8 pixels of the decoded default
/// image. Neither digest proves identity with the browser's earlier download.
/// The ten-second deadline covers network acquisition, not CPU image validation.
/// Errors contain only safe categories/status codes, never request URLs,
/// redirect Locations, response bodies, or third-party error descriptions.
pub fn read_original_image(url: &str) -> Result<Value, String> {
    read_with_limits(url, MAX_ENCODED_BYTES, MAX_PIXELS, REQUEST_TIMEOUT)
}

fn read_with_limits(
    url: &str,
    max_bytes: usize,
    max_pixels: u64,
    timeout: Duration,
) -> Result<Value, String> {
    let started = Instant::now();
    let input = parse_url(url, None)?;
    let fetched = fetch_image(input.clone(), max_bytes, timeout)?;
    let fetch_ms = started.elapsed().as_secs_f64() * 1000.0;
    let validation_started = Instant::now();
    let (format, width, height, rgba8_sha256) = validate_image(&fetched.bytes, max_pixels)?;
    let sha256 = digest(&fetched.bytes);
    let validation_ms = validation_started.elapsed().as_secs_f64() * 1000.0;
    Ok(json!({
        "acquisition": "explicit-url-request",
        "originalDropByteIdentity": "unverified",
        "inputUrl": redacted_url(&input),
        "inputUrlHadQuery": input.query().is_some(),
        "finalUrl": redacted_url(&fetched.final_url),
        "finalUrlHadQuery": fetched.final_url.query().is_some(),
        "redirectCount": fetched.redirects,
        "httpStatus": fetched.status,
        "headerContentType": fetched.header_content_type,
        "format": format_name(format),
        "mime": format.to_mime_type(),
        "width": width,
        "height": height,
        "encodedBytes": fetched.bytes.len(),
        "sha256": sha256,
        "rgba8Sha256": rgba8_sha256,
        "rgba8Scope": "decoded-default-image",
        "fetchMs": fetch_ms,
        "validationMs": validation_ms,
        "totalMs": started.elapsed().as_secs_f64() * 1000.0,
    }))
}

struct FetchedImage {
    bytes: Vec<u8>,
    final_url: Url,
    redirects: usize,
    status: u16,
    header_content_type: Option<String>,
}

fn fetch_image(mut url: Url, max_bytes: usize, timeout: Duration) -> Result<FetchedImage, String> {
    let deadline = Instant::now() + timeout;
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(timeout.min(REQUEST_TIMEOUT))
        .timeout(timeout)
        .build()
        .map_err(|_| "could not initialize image HTTP client")?;

    for redirects in 0..=MAX_REDIRECTS {
        validate_url(&url)?;
        // Set the request timeout too: reqwest propagates this into its async
        // response-body deadline, so a stalled/slow-drip body cannot reset it.
        let remaining = remaining_time(deadline)?;
        let mut response = client
            .get(url.clone())
            .timeout(remaining)
            .send()
            // Never format third-party errors: they can contain signed URLs.
            .map_err(|error| {
                if error.is_timeout() {
                    "image request deadline exceeded"
                } else {
                    "image HTTP request failed"
                }
            })?;
        remaining_time(deadline)?;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects == MAX_REDIRECTS {
                return Err("image request exceeded 5 redirects".into());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("image redirect has no valid Location")?;
            url = parse_url(location, Some(&url))?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("image request returned HTTP {}", status.as_u16()));
        }
        // A partial response is not an acquisition of the complete entity.
        if status.as_u16() == 206 {
            return Err("image request returned a partial response".into());
        }
        // Keep content-encoded responses from being mistaken for image bytes.
        // No Accept-Encoding is added, and automatic decompression is disabled.
        if response
            .headers()
            .get_all(CONTENT_ENCODING)
            .iter()
            .any(|value| {
                value
                    .to_str()
                    .map_or(true, |value| !value.eq_ignore_ascii_case("identity"))
            })
        {
            return Err("image response uses unsupported Content-Encoding".into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > max_bytes as u64)
        {
            return Err("image response exceeds encoded byte limit".into());
        }
        // Record only the media type, not arbitrary parameters echoed by a server.
        let header_content_type = response.headers().get(CONTENT_TYPE).map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| {
                    let media_type = value.split(';').next()?.trim();
                    (media_type.len() <= 127
                        && media_type.contains('/')
                        && media_type
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"/!#$&^_.+-".contains(&b)))
                    .then(|| media_type.to_ascii_lowercase())
                })
                .unwrap_or_else(|| "invalid".into())
        });
        let bytes = read_capped(&mut response, max_bytes, deadline)?;
        return Ok(FetchedImage {
            bytes,
            final_url: url,
            redirects,
            status: status.as_u16(),
            header_content_type,
        });
    }
    unreachable!("redirect loop returns on its last iteration")
}

fn remaining_time(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "image request deadline exceeded".into())
}

fn read_capped(
    reader: &mut impl Read,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        remaining_time(deadline)?;
        // One extra byte distinguishes exact-limit EOF from an oversized stream,
        // without storing any bytes beyond the cap or trusting Content-Length.
        let read_len = buffer
            .len()
            .min((max_bytes - bytes.len()).saturating_add(1));
        let count = reader
            .read(&mut buffer[..read_len])
            .map_err(|_| "image response body read failed or timed out")?;
        remaining_time(deadline)?;
        if count == 0 {
            return Ok(bytes);
        }
        if count > max_bytes - bytes.len() {
            return Err("image response exceeds encoded byte limit".into());
        }
        if bytes.capacity() - bytes.len() < count {
            let capacity = bytes
                .capacity()
                .saturating_mul(2)
                .max(bytes.len() + count)
                .min(max_bytes);
            bytes
                .try_reserve_exact(capacity - bytes.len())
                .map_err(|_| "could not allocate image response buffer")?;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn parse_url(raw: &str, base: Option<&Url>) -> Result<Url, String> {
    // URL parsing can erase empty userinfo (http://@host), and HTTP URL parsing
    // treats backslashes as slashes. Reject userinfo before that normalization.
    if raw.chars().any(char::is_control) {
        return Err("image URL contains control characters".into());
    }
    let normalized = raw.trim().replace('\\', "/");
    let authority = if let Some(rest) = normalized.strip_prefix("//") {
        Some(rest.trim_start_matches('/'))
    } else if let Some((scheme, rest)) = normalized.split_once(':') {
        if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
            Some(rest.trim_start_matches('/'))
        } else {
            None
        }
    } else {
        None
    };
    if authority.is_some_and(|rest| {
        rest.split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .contains('@')
    }) {
        return Err("image URL must not contain credentials or userinfo".into());
    }
    let url = match base {
        Some(base) => base.join(raw),
        None => Url::parse(raw),
    }
    .map_err(|_| "invalid image URL")?;
    validate_url(&url)?;
    Ok(url)
}

fn validate_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("image URL must use http or https with a host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("image URL must not contain credentials or userinfo".into());
    }
    Ok(())
}

fn redacted_url(url: &Url) -> String {
    let mut url = url.clone();
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn validate_image(
    bytes: &[u8],
    max_pixels: u64,
) -> Result<(ImageFormat, u32, u32, String), String> {
    let format = image::guess_format(bytes).map_err(|_| "response is not a recognized image")?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::WebP
            | ImageFormat::Gif
            | ImageFormat::Bmp
            | ImageFormat::Tiff
    ) {
        return Err("response image format is not supported".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(max_pixels.min(u32::MAX as u64) as u32);
    limits.max_image_height = limits.max_image_width;
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "invalid image header or decoder limits exceeded")?;
    let (width, height) = decoder.dimensions();
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 || pixels > max_pixels {
        return Err("image dimensions exceed pixel limit or are empty".into());
    }
    // Reserve output storage just as ImageReader::decode does, but only after
    // checking width * height, before any full pixel decode/allocation.
    limits
        .reserve(decoder.total_bytes())
        .map_err(|_| "image exceeds decoded allocation limit")?;
    decoder
        .set_limits(limits)
        .map_err(|_| "image exceeds decoder limits")?;
    let decoded = DynamicImage::from_decoder(decoder).map_err(|_| "image full decode failed")?;
    let rgba = decoded.into_rgba8();
    Ok((format, width, height, digest(rgba.as_raw())))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::WebP => "webp",
        ImageFormat::Gif => "gif",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
        _ => unreachable!("validate_image rejects unsupported formats"),
    }
}

#[cfg(test)]
mod original_image_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};

    const PIXELS: [u8; 8] = [255, 0, 0, 255, 0, 128, 255, 64];

    fn fixture(format: ImageFormat) -> Vec<u8> {
        let image = image::RgbaImage::from_raw(2, 1, PIXELS.to_vec()).unwrap();
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, format)
            .unwrap();
        output.into_inner()
    }

    struct Reply {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        chunked: bool,
        delay: Duration,
        body_delay: Duration,
        chunk_delay: Duration,
        declared_length: Option<usize>,
    }

    impl Reply {
        fn image(body: Vec<u8>, media_type: &str) -> Self {
            Self {
                status: 200,
                headers: vec![("Content-Type".into(), media_type.into())],
                body,
                chunked: false,
                delay: Duration::ZERO,
                body_delay: Duration::ZERO,
                chunk_delay: Duration::ZERO,
                declared_length: None,
            }
        }

        fn redirect(location: &str) -> Self {
            Self {
                status: 302,
                headers: vec![("Location".into(), location.into())],
                ..Self::image(Vec::new(), "text/plain")
            }
        }
    }

    // All integration traffic is to an ephemeral Linux loopback listener.
    // Accept has a deadline so an unexpected client rejection cannot hang tests.
    struct Server {
        base: String,
        requests: Arc<Mutex<Vec<String>>>,
        thread: Option<JoinHandle<()>>,
    }

    impl Server {
        fn start(replies: Vec<Reply>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let thread = thread::spawn(move || {
                for reply in replies {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    let mut stream = loop {
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(
                                    Instant::now() < deadline,
                                    "loopback server never received request"
                                );
                                thread::sleep(Duration::from_millis(2));
                            }
                            Err(error) => panic!("loopback accept failed: {error}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        assert!(reader.read_line(&mut line).unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        request.push_str(&line);
                    }
                    recorded.lock().unwrap().push(request);
                    thread::sleep(reply.delay);
                    // A cap/timeout may deliberately close the connection early.
                    let _ = write_reply(&mut stream, reply);
                }
            });
            Self {
                base,
                requests,
                thread: Some(thread),
            }
        }

        fn url(&self) -> String {
            format!("{}/image", self.base)
        }

        fn finish(mut self) -> Vec<String> {
            self.thread.take().unwrap().join().unwrap();
            self.requests.lock().unwrap().clone()
        }
    }

    fn write_reply(stream: &mut TcpStream, reply: Reply) -> std::io::Result<()> {
        write!(
            stream,
            "HTTP/1.1 {} Test\r\nConnection: close\r\n",
            reply.status
        )?;
        for (name, value) in reply.headers {
            write!(stream, "{name}: {value}\r\n")?;
        }
        if reply.chunked {
            write!(stream, "Transfer-Encoding: chunked\r\n\r\n")?;
            thread::sleep(reply.body_delay);
            for chunk in reply.body.chunks(7) {
                thread::sleep(reply.chunk_delay);
                write!(stream, "{:x}\r\n", chunk.len())?;
                stream.write_all(chunk)?;
                stream.write_all(b"\r\n")?;
            }
            stream.write_all(b"0\r\n\r\n")
        } else {
            write!(
                stream,
                "Content-Length: {}\r\n\r\n",
                reply.declared_length.unwrap_or(reply.body.len())
            )?;
            thread::sleep(reply.body_delay);
            stream.write_all(&reply.body)
        }
    }

    #[test]
    fn original_image_png_and_webp_preserve_response_bytes() {
        for (format, name, mime) in [
            (ImageFormat::Png, "png", "image/png"),
            (ImageFormat::WebP, "webp", "image/webp"),
        ] {
            let bytes = fixture(format);
            let server = Server::start(vec![Reply::image(
                bytes.clone(),
                "application/octet-stream",
            )]);
            let value = read_original_image(&server.url()).unwrap();
            assert_eq!(value["format"], name);
            assert_eq!(value["mime"], mime);
            assert_eq!(value["width"], 2);
            assert_eq!(value["height"], 1);
            assert_eq!(value["encodedBytes"], bytes.len());
            assert_eq!(value["sha256"], digest(&bytes));
            assert_eq!(value["rgba8Sha256"], digest(&PIXELS));
            assert_eq!(value["acquisition"], "explicit-url-request");
            assert_eq!(value["originalDropByteIdentity"], "unverified");
            assert!(value["validationMs"].as_f64().unwrap() >= 0.0);
            assert!(!value.as_object().unwrap().values().any(Value::is_array));
            if format == ImageFormat::WebP {
                assert_ne!(value["sha256"], digest(&fixture(ImageFormat::Png)));
            }
            server.finish();
        }
    }

    #[test]
    fn original_image_redirects_send_query_but_reports_redact_it() {
        let server = Server::start(vec![
            Reply::redirect("/final?signature=FINAL_SECRET#FINAL_FRAGMENT"),
            Reply::image(
                fixture(ImageFormat::WebP),
                "image/png; source=HEADER_SECRET",
            ),
        ]);
        let value = read_original_image(&format!(
            "{}?token=INPUT_SECRET#INPUT_FRAGMENT",
            server.url()
        ))
        .unwrap();
        assert_eq!(value["inputUrl"], server.url());
        assert_eq!(value["finalUrl"], format!("{}/final", server.base));
        assert_eq!(value["inputUrlHadQuery"], true);
        assert_eq!(value["finalUrlHadQuery"], true);
        assert_eq!(value["redirectCount"], 1);
        assert_eq!(value["headerContentType"], "image/png");
        assert_eq!(value["mime"], "image/webp");
        let report = value.to_string();
        for secret in [
            "INPUT_SECRET",
            "FINAL_SECRET",
            "HEADER_SECRET",
            "INPUT_FRAGMENT",
            "FINAL_FRAGMENT",
        ] {
            assert!(!report.contains(secret));
        }
        let requests = server.finish();
        assert!(requests[0].starts_with("GET /image?token=INPUT_SECRET HTTP/1.1"));
        assert!(requests[1].starts_with("GET /final?signature=FINAL_SECRET HTTP/1.1"));
        for request in requests {
            let lower = request.to_ascii_lowercase();
            for header in [
                "cookie:",
                "authorization:",
                "proxy-authorization:",
                "referer:",
                "accept-encoding:",
                "user-agent:",
            ] {
                assert!(!lower.contains(header), "unexpected header {header}");
            }
            assert!(!request.contains("FRAGMENT"));
        }
    }

    #[test]
    fn original_image_five_redirects_succeed_sixth_is_rejected() {
        let mut replies: Vec<_> = (0..5).map(|_| Reply::redirect("/next")).collect();
        replies.push(Reply::image(fixture(ImageFormat::Png), "image/png"));
        let server = Server::start(replies);
        assert_eq!(
            read_original_image(&server.url()).unwrap()["redirectCount"],
            5
        );
        assert_eq!(server.finish().len(), 6);

        let server = Server::start(
            (0..6)
                .map(|_| Reply::redirect("/loop?secret=REDIRECT_SECRET"))
                .collect(),
        );
        let error = read_original_image(&server.url()).unwrap_err();
        assert!(error.contains("5 redirects"));
        assert!(!error.contains("REDIRECT_SECRET"));
        assert_eq!(server.finish().len(), 6);
    }

    #[test]
    fn original_image_rejects_protocols_and_userinfo_before_connecting() {
        for url in [
            "file:///tmp/image.png",
            "data:image/png;base64,secret",
            "ftp://127.0.0.1/image",
            "http://name:PASS_SECRET@127.0.0.1/image?QUERY_SECRET",
            "http://name@127.0.0.1/",
            "http://@127.0.0.1/",
            "http://:PASS_SECRET@127.0.0.1/",
            "http:\\@127.0.0.1/",
            "http://127.0.0.1/\n?QUERY_SECRET",
            "not a URL?QUERY_SECRET",
        ] {
            let error = read_original_image(url).unwrap_err();
            assert!(!error.contains("SECRET"));
            assert!(
                !error.contains("HTTP request failed"),
                "must reject before requesting: {url}"
            );
        }
    }

    #[test]
    fn original_image_rejects_redirect_protocols_and_credentials() {
        for location in [
            "file:///tmp/image.png",
            "ftp://127.0.0.1/image",
            "http://user:PASS_SECRET@127.0.0.1/",
            "//user@127.0.0.1/",
            "http://@127.0.0.1/",
        ] {
            let server = Server::start(vec![Reply::redirect(location)]);
            let error = read_original_image(&server.url()).unwrap_err();
            assert!(!error.contains("SECRET"));
            assert!(!error.contains("HTTP request failed"));
            assert_eq!(server.finish().len(), 1);
        }
    }

    #[test]
    fn original_image_headers_cannot_make_nonimages_or_corrupt_images_succeed() {
        let mut corrupt = fixture(ImageFormat::Png);
        // Keep the signature and IHDR; remove the actual compressed pixel data.
        corrupt.truncate(41);
        for body in [
            b"<html>not an image</html>".to_vec(),
            corrupt,
            b"RIFF\x20\0\0\0WEBPbroken".to_vec(),
        ] {
            let server = Server::start(vec![Reply::image(body, "image/png")]);
            assert!(read_original_image(&server.url()).is_err());
            server.finish();
        }
    }

    #[test]
    fn original_image_http_errors_partial_and_content_encoding_fail() {
        for status in [404, 500, 206, 304] {
            let mut reply = Reply::image(fixture(ImageFormat::Png), "image/png");
            reply.status = status;
            let server = Server::start(vec![reply]);
            let error = read_original_image(&format!("{}?QUERY_SECRET", server.url())).unwrap_err();
            assert!(!error.contains("QUERY_SECRET"));
            server.finish();
        }
        let mut reply = Reply::image(fixture(ImageFormat::Png), "image/png");
        reply
            .headers
            .push(("Content-Encoding".into(), "gzip".into()));
        let server = Server::start(vec![reply]);
        assert!(
            read_original_image(&server.url())
                .unwrap_err()
                .contains("Content-Encoding")
        );
        server.finish();
    }

    #[test]
    fn original_image_encoded_limit_checks_header_and_actual_chunked_stream() {
        let bytes = fixture(ImageFormat::Png);
        for chunked in [false, true] {
            for cap in [bytes.len() - 1, bytes.len(), bytes.len() + 1] {
                let mut reply = Reply::image(bytes.clone(), "image/png");
                reply.chunked = chunked;
                let server = Server::start(vec![reply]);
                let result = read_with_limits(&server.url(), cap, MAX_PIXELS, REQUEST_TIMEOUT);
                if cap < bytes.len() {
                    assert!(result.unwrap_err().contains("encoded byte limit"));
                } else {
                    assert_eq!(result.unwrap()["sha256"], digest(&bytes));
                }
                server.finish();
            }
        }
    }

    #[test]
    fn original_image_pixel_cap_is_checked_before_full_decode() {
        // Both dimensions fit the three-pixel cap; only their product exceeds it.
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(2, 2)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let mut bytes = bytes.into_inner();
        bytes.truncate(41); // Complete IHDR + IDAT header, missing pixel data.
        let server = Server::start(vec![Reply::image(bytes, "image/png")]);
        let error =
            read_with_limits(&server.url(), MAX_ENCODED_BYTES, 3, REQUEST_TIMEOUT).unwrap_err();
        assert!(
            error.contains("pixel limit"),
            "dimension rejection must precede decode: {error}"
        );
        server.finish();
    }

    #[test]
    fn original_image_production_pixel_limit_rejects_large_png_header() {
        let mut bytes = fixture(ImageFormat::Png);
        bytes[16..20].copy_from_slice(&8001_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&8000_u32.to_be_bytes());
        // Recompute IHDR CRC, so rejection is about 64M pixels, not corruption.
        let mut crc = !0_u32;
        for byte in &bytes[12..29] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320_u32 & 0_u32.wrapping_sub(crc & 1));
            }
        }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        bytes.truncate(41);
        let server = Server::start(vec![Reply::image(bytes, "image/png")]);
        assert!(
            read_original_image(&server.url())
                .unwrap_err()
                .contains("pixel limit")
        );
        server.finish();
    }

    #[test]
    fn original_image_body_and_redirects_share_network_deadline() {
        for slow_drip in [false, true] {
            let mut reply = Reply::image(fixture(ImageFormat::Png), "image/png");
            reply.chunked = true;
            if slow_drip {
                reply.chunk_delay = Duration::from_millis(60);
            } else {
                reply.body_delay = Duration::from_millis(350);
            }
            let server = Server::start(vec![reply]);
            let started = Instant::now();
            assert!(
                read_with_limits(
                    &server.url(),
                    MAX_ENCODED_BYTES,
                    MAX_PIXELS,
                    Duration::from_millis(180)
                )
                .is_err()
            );
            assert!(started.elapsed() < Duration::from_millis(500));
            server.finish();
        }

        let mut first = Reply::redirect("/second?QUERY_SECRET");
        first.delay = Duration::from_millis(120);
        let mut second = Reply::image(fixture(ImageFormat::Png), "image/png");
        second.delay = Duration::from_millis(120);
        let server = Server::start(vec![first, second]);
        let error = read_with_limits(
            &server.url(),
            MAX_ENCODED_BYTES,
            MAX_PIXELS,
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(error.contains("deadline"));
        assert!(!error.contains("QUERY_SECRET"));
        assert_eq!(server.finish().len(), 2);
    }

    #[test]
    fn original_image_network_deadline_and_errors_do_not_leak_queries() {
        let mut reply = Reply::image(fixture(ImageFormat::Png), "image/png");
        reply.delay = Duration::from_millis(200);
        let server = Server::start(vec![reply]);
        let started = Instant::now();
        let error = read_with_limits(
            &format!("{}?QUERY_SECRET", server.url()),
            MAX_ENCODED_BYTES,
            MAX_PIXELS,
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert!(!error.contains("QUERY_SECRET"));
        assert!(error.contains("deadline"));
        assert!(started.elapsed() < Duration::from_secs(1));
        server.finish();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/?QUERY_SECRET", listener.local_addr().unwrap());
        drop(listener);
        let error = read_original_image(&url).unwrap_err();
        assert!(!error.contains("QUERY_SECRET"));
        assert_eq!(error, "image HTTP request failed");
    }

    #[test]
    fn original_image_redirect_failure_diagnostics_never_include_signed_urls() {
        for location in [
            "http://[invalid?signature=FINAL_SECRET#FINAL_FRAGMENT",
            "http://name:PASS_SECRET@127.0.0.1/?signature=FINAL_SECRET",
        ] {
            let server = Server::start(vec![Reply::redirect(location)]);
            let error =
                read_original_image(&format!("{}?token=INPUT_SECRET", server.url())).unwrap_err();
            assert!(!error.contains("SECRET"));
            assert!(!error.contains("FRAGMENT"));
            assert!(!error.contains(&server.base));
            server.finish();
        }

        let mut not_found = Reply::image(b"FINAL_SECRET".to_vec(), "image/png");
        not_found.status = 404;
        for reply in [
            not_found,
            Reply::image(b"FINAL_SECRET".to_vec(), "image/png"),
        ] {
            let server = Server::start(vec![
                Reply::redirect("/final?signature=FINAL_SECRET#FINAL_FRAGMENT"),
                reply,
            ]);
            let error =
                read_original_image(&format!("{}?token=INPUT_SECRET", server.url())).unwrap_err();
            assert!(!error.contains("SECRET"));
            assert!(!error.contains("FRAGMENT"));
            assert!(!error.contains(&server.base));
            assert_eq!(server.finish().len(), 2);
        }
    }

    #[test]
    fn original_image_truncated_http_body_fails_without_url_or_partial_success() {
        let mut reply = Reply::image(fixture(ImageFormat::Png), "image/png");
        // Even a fully decodable PNG must fail if the HTTP entity is incomplete.
        reply.declared_length = Some(reply.body.len() + 50);
        let server = Server::start(vec![
            Reply::redirect("/final?signature=FINAL_SECRET"),
            reply,
        ]);
        let error =
            read_original_image(&format!("{}?token=INPUT_SECRET", server.url())).unwrap_err();
        assert_eq!(error, "image response body read failed or timed out");
        assert_eq!(server.finish().len(), 2);
    }

    #[test]
    fn original_image_redaction_removes_userinfo_query_and_fragment() {
        let url = Url::parse(
            "https://name:PASS_SECRET@example.test/picture?QUERY_SECRET#FRAGMENT_SECRET",
        )
        .unwrap();
        assert_eq!(redacted_url(&url), "https://example.test/picture");
        let server = Server::start(vec![Reply::image(fixture(ImageFormat::Png), "image/png")]);
        let value = read_original_image(&server.url()).unwrap();
        assert_eq!(value["inputUrlHadQuery"], false);
        assert_eq!(value["finalUrlHadQuery"], false);
        server.finish();
    }
}
