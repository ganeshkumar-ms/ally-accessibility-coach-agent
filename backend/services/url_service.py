import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Dict, List, Optional, Tuple

SUPPORTED_LINKS_DESC = (
    'Public HTTP/HTTPS web page URLs (HTML / XHTML pages, landing pages, docs, or web forms; max 2 MB)'
)
MAX_FETCH_BYTES = 2 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 12
MAX_REDIRECTS = 5

_BLOCKED_HOST_SUFFIXES = ('.local', '.internal', '.localhost', '.arpa', '.home', '.lan')
_NON_DESCRIPTIVE_LINK_TEXTS = {
    'click here', 'here', 'read more', 'learn more', 'more', 'more info',
    'details', 'link', 'go', 'continue', 'submit', 'view', 'open',
}
_HTML_SNIPPET_MARKERS = (
    '<html', '<!doctype', '<head', '<body', '<div', '<form', '<input',
    '<button', '<a ', '<img', '<table', '<nav', '<label', '<h1', '<h2',
    'onclick=', 'classname=', 'aria-label=',
)


class _BlockedUrlError(ValueError):
    def __init__(self, reason_code: str, title: str, why: str, technical_detail: str, how_to_fix: str):
        super().__init__(why)
        self.reason_code = reason_code
        self.title = title
        self.why = why
        self.technical_detail = technical_detail
        self.how_to_fix = how_to_fix


def _build_link_rejection(
    reason_code: str,
    title: str,
    url: str,
    why: str,
    technical_detail: str,
    how_to_fix: str,
) -> Dict:
    message = (
        f"Link Not Accepted — {title}\n\n"
        f"• URL: {url}\n"
        f"• Why It Was Not Accepted: {why}\n"
        f"• Technical Details: {technical_detail}\n"
        f"• Supported Links for ALLY: {SUPPORTED_LINKS_DESC}\n"
        f"• How to Fix & Retry: {how_to_fix}"
    )
    return {
        'rejected': True,
        'reason_code': reason_code,
        'title': title,
        'url': url,
        'reason': why,
        'technical_detail': technical_detail,
        'supported_formats': SUPPORTED_LINKS_DESC,
        'how_to_fix': how_to_fix,
        'message': message,
    }


def _clean_extracted_url(raw: str) -> str:
    url = raw.strip().rstrip('.,;:!?)\'"`]>')
    if url.lower().startswith('www.'):
        url = 'https://' + url
    return url


def extract_target_url(user_message: str = '', explicit_url: str = '') -> Tuple[Optional[str], Optional[Dict]]:
    """
    Extracts an explicit URL or a URL pasted in user_message (unless user_message is pasted HTML/JSX markup).
    Returns (normalized_url, rejection_dict_if_invalid_scheme).
    """
    if explicit_url and explicit_url.strip():
        candidate = _clean_extracted_url(explicit_url)
        parsed = urllib.parse.urlparse(candidate)
        if not parsed.scheme:
            candidate = 'https://' + candidate
            parsed = urllib.parse.urlparse(candidate)
        if parsed.scheme.lower() not in ('http', 'https'):
            return None, _build_link_rejection(
                reason_code='UNSUPPORTED_URL_SCHEME',
                title='Unsupported URL Protocol / Scheme',
                url=candidate,
                why=f"ALLY only fetches public web pages over http:// or https://, not '{parsed.scheme}://'.",
                technical_detail=f"Detected scheme '{parsed.scheme or 'none'}' in explicit URL input.",
                how_to_fix='Provide a full public http:// or https:// web address, or upload/paste the page HTML directly.',
            )
        return candidate, None

    msg = (user_message or '').strip()
    if not msg:
        return None, None

    lowered = msg.lower()
    if any(marker in lowered for marker in _HTML_SNIPPET_MARKERS):
        return None, None

    bad_scheme_match = re.search(r'\b(?:file|ftp|ftps|javascript|data|mailto|tel):[^\s<>"\']+', msg, flags=re.IGNORECASE)
    if bad_scheme_match:
        bad_url = bad_scheme_match.group(0).rstrip('.,;:!?)')
        scheme = bad_url.split(':', 1)[0].lower()
        return None, _build_link_rejection(
            reason_code='UNSUPPORTED_URL_SCHEME',
            title='Unsupported Link Protocol',
            url=bad_url,
            why=f"ALLY cannot fetch '{scheme}:' links. Only public http:// and https:// web page URLs can be loaded.",
            technical_detail=f"Detected non-HTTP scheme '{scheme}:' in prompt.",
            how_to_fix='Paste a valid public https:// or http:// page URL, or save the page as an .html file and attach it.',
        )

    url_match = re.search(r'\bhttps?://[^\s<>"\']+', msg, flags=re.IGNORECASE)
    if url_match:
        return _clean_extracted_url(url_match.group(0)), None

    www_match = re.search(r'\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:/[^\s<>"\']*)?', msg, flags=re.IGNORECASE)
    if www_match:
        return _clean_extracted_url(www_match.group(0)), None

    return None, None


def _is_public_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _validate_public_url(url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url)
    scheme = (parsed.scheme or '').lower()
    if scheme not in ('http', 'https'):
        raise _BlockedUrlError(
            reason_code='UNSUPPORTED_URL_SCHEME',
            title='Unsupported URL Protocol',
            why=f"Only http:// and https:// web URLs are accepted (received '{scheme or 'empty'}').",
            technical_detail=f"Scheme validation failed for '{url}'.",
            how_to_fix='Start the URL with https:// or http:// (for example, https://example.com).',
        )

    host = (parsed.hostname or '').strip().lower()
    if not host or '.' not in host and host != 'localhost':
        # Single-label host without dot (e.g., intranet service name or localhost)
        raise _BlockedUrlError(
            reason_code='INVALID_OR_INTERNAL_HOST',
            title='Invalid or Internal Hostname',
            why=f"The URL host '{host or '(missing)'}' is not a valid public internet domain.",
            technical_detail='Single-label/internal hostnames and malformed URLs cannot be fetched externally.',
            how_to_fix='Provide a full public domain URL (e.g., https://example.com/page), or paste the HTML source directly.',
        )

    if host == 'localhost' or host.endswith(_BLOCKED_HOST_SUFFIXES):
        raise _BlockedUrlError(
            reason_code='PRIVATE_OR_LOCAL_URL_BLOCKED',
            title='Local / Internal Network URL Blocked',
            why=f"URLs pointing to localhost or internal domains ('{host}') cannot be accessed from ALLY's cloud sandbox.",
            technical_detail='SSRF guard blocked loopback/internal domain name.',
            how_to_fix='Deploy or expose the page on a public URL, or upload/paste the local HTML/JSX file directly in ALLY.',
        )

    # Direct IP literal check
    try:
        ipaddress.ip_address(host)
        if not _is_public_ip(host):
            raise _BlockedUrlError(
                reason_code='PRIVATE_OR_LOCAL_URL_BLOCKED',
                title='Private / Reserved IP Address Blocked',
                why=f"Private, loopback, or cloud-metadata IP addresses ('{host}') are blocked for security.",
                technical_detail=f'IP address {host} failed public routing check.',
                how_to_fix='Use a public website domain URL, or upload/paste the HTML page directly.',
            )
    except ValueError:
        pass

    # DNS resolution check (all A/AAAA records must be public)
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise _BlockedUrlError(
            reason_code='DNS_RESOLUTION_FAILED',
            title='Website Domain Not Found (DNS Error)',
            why=f"The domain '{host}' could not be resolved on the public internet.",
            technical_detail=f'DNS lookup failed: {exc}',
            how_to_fix='Check the spelling of the domain name and ensure the site is publicly accessible online.',
        )

    resolved_ips = {item[4][0] for item in infos if item and len(item) >= 5 and item[4]}
    if not resolved_ips or any(not _is_public_ip(ip) for ip in resolved_ips):
        raise _BlockedUrlError(
            reason_code='PRIVATE_OR_LOCAL_URL_BLOCKED',
            title='Non-Public Target IP Blocked',
            why=f"The hostname '{host}' resolves to a private or non-routable IP address and cannot be fetched.",
            technical_detail=f'Resolved IPs {sorted(resolved_ips)} failed public IP policy.',
            how_to_fix='Only publicly hosted websites are supported by URL; upload the page HTML/JSX file for local or staging pages.',
        )

    return parsed


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _AccessibilityHtmlInspector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.html_lang: Optional[str] = None
        self.title_text: str = ''
        self._in_title = False
        self.landmarks: List[str] = []
        self.headings: List[Tuple[str, str]] = []
        self._current_heading_tag: Optional[str] = None
        self._current_heading_buf: List[str] = []
        self.img_total = 0
        self.imgs_missing_alt = 0
        self.imgs_empty_alt = 0
        self.sample_bad_imgs: List[str] = []
        self.links_total = 0
        self.non_descriptive_links: List[str] = []
        self.empty_links = 0
        self._in_link = False
        self._link_has_aria = False
        self._link_href = ''
        self._link_buf: List[str] = []
        self.buttons_total = 0
        self.empty_buttons = 0
        self._in_button = False
        self._button_has_aria = False
        self._button_buf: List[str] = []
        self.clickable_divs = 0
        self.form_controls_total = 0
        self.labels_for: set = set()
        self.unlabeled_controls: List[str] = []
        self.tables_total = 0
        self.skip_link_found = False

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]):
        t = tag.lower()
        attr_map = {k.lower(): (v or '') for k, v in attrs if k}

        if t == 'html':
            self.html_lang = attr_map.get('lang', '').strip() or None
        elif t == 'title':
            self._in_title = True
        elif t in ('header', 'nav', 'main', 'footer', 'aside'):
            if t not in self.landmarks:
                self.landmarks.append(t)
        elif attr_map.get('role') in ('banner', 'navigation', 'main', 'contentinfo'):
            role = f"role={attr_map.get('role')}"
            if role not in self.landmarks:
                self.landmarks.append(role)

        if t in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._current_heading_tag = t
            self._current_heading_buf = []
        elif t == 'img':
            self.img_total += 1
            if 'alt' not in attr_map:
                self.imgs_missing_alt += 1
                if len(self.sample_bad_imgs) < 5:
                    src = attr_map.get('src', '')[:70]
                    self.sample_bad_imgs.append(f'<img src="{src}"> (missing alt attribute)')
            elif attr_map['alt'].strip() == '':
                self.imgs_empty_alt += 1
        elif t == 'a':
            self.links_total += 1
            self._in_link = True
            self._link_has_aria = bool(attr_map.get('aria-label', '').strip() or attr_map.get('aria-labelledby', '').strip())
            self._link_href = attr_map.get('href', '')
            self._link_buf = []
            if self._link_href.startswith('#') and ('main' in self._link_href.lower() or 'content' in self._link_href.lower()):
                self.skip_link_found = True
        elif t == 'button':
            self.buttons_total += 1
            self._in_button = True
            self._button_has_aria = bool(attr_map.get('aria-label', '').strip() or attr_map.get('aria-labelledby', '').strip())
            self._button_buf = []
        elif t in ('div', 'span') and ('onclick' in attr_map or attr_map.get('role') == 'button'):
            self.clickable_divs += 1
        elif t == 'label':
            if attr_map.get('for'):
                self.labels_for.add(attr_map['for'].strip())
        elif t in ('input', 'select', 'textarea'):
            itype = attr_map.get('type', 'text').lower()
            if itype not in ('hidden', 'submit', 'button', 'reset', 'image'):
                self.form_controls_total += 1
                cid = attr_map.get('id', '').strip()
                has_aria = bool(attr_map.get('aria-label', '').strip() or attr_map.get('aria-labelledby', '').strip())
                if not has_aria and (not cid or cid not in self.labels_for):
                    if len(self.unlabeled_controls) < 6:
                        name = attr_map.get('name') or cid or attr_map.get('placeholder') or itype
                        self.unlabeled_controls.append(f'<{t} type="{itype}" name/placeholder="{name[:40]}">')
        elif t == 'table':
            self.tables_total += 1

    def handle_endtag(self, tag: str):
        t = tag.lower()
        if t == 'title':
            self._in_title = False
        elif t == self._current_heading_tag:
            txt = ' '.join(''.join(self._current_heading_buf).split())[:100]
            self.headings.append((t, txt))
            self._current_heading_tag = None
            self._current_heading_buf = []
        elif t == 'a' and self._in_link:
            txt = ' '.join(''.join(self._link_buf).split())
            low = txt.lower()
            if not txt and not self._link_has_aria:
                self.empty_links += 1
            elif low in _NON_DESCRIPTIVE_LINK_TEXTS and len(self.non_descriptive_links) < 6:
                self.non_descriptive_links.append(f'"{txt}" -> {self._link_href[:60]}')
            self._in_link = False
        elif t == 'button' and self._in_button:
            txt = ' '.join(''.join(self._button_buf).split())
            if not txt and not self._button_has_aria:
                self.empty_buttons += 1
            self._in_button = False

    def handle_data(self, data: str):
        if self._in_title:
            self.title_text += data
        if self._current_heading_tag:
            self._current_heading_buf.append(data)
        if self._in_link:
            self._link_buf.append(data)
        if self._in_button:
            self._button_buf.append(data)


def _strip_noise_html(html: str) -> str:
    cleaned = re.sub(r'<(script|style|noscript)[^>]*>[\s\S]*?</\1>', '', html, flags=re.IGNORECASE)
    return re.sub(r'\n{3,}', '\n\n', cleaned).strip()


def _build_webpage_accessibility_digest(final_url: str, status: int, content_type: str, html_text: str) -> str:
    inspector = _AccessibilityHtmlInspector()
    try:
        inspector.feed(html_text)
        inspector.close()
    except Exception:
        pass

    heading_lines = [f"  - <{tag}> {text or '(empty)'}" for tag, text in inspector.headings[:25]]
    lines = [
        '[FETCHED WEBPAGE ACCESSIBILITY DIGEST]',
        f'- Final URL: {final_url}',
        f'- HTTP Status: {status} | Content-Type: {content_type}',
        f'- <html lang>: {inspector.html_lang or "MISSING (WCAG 3.1.1 Page Language)"}',
        f'- <title>: {" ".join(inspector.title_text.split())[:140] or "MISSING (WCAG 2.4.2 Page Titled)"}',
        f'- Landmarks Found: {", ".join(inspector.landmarks) if inspector.landmarks else "None detected (<header>/<nav>/<main>/<footer> missing)"}',
        f'- Skip Link Detected: {"Yes" if inspector.skip_link_found else "No"}',
        f'- Headings ({len(inspector.headings)}):',
        *(heading_lines or ['  - None detected']),
        f'- Images: {inspector.img_total} total | missing alt={inspector.imgs_missing_alt} | empty alt=""={inspector.imgs_empty_alt}',
    ]
    if inspector.sample_bad_imgs:
        lines.append('  Missing-alt image samples: ' + '; '.join(inspector.sample_bad_imgs))
    lines.append(
        f'- Links: {inspector.links_total} total | empty/unlabeled={inspector.empty_links} | non-descriptive={len(inspector.non_descriptive_links)}'
    )
    if inspector.non_descriptive_links:
        lines.append('  Non-descriptive links: ' + '; '.join(inspector.non_descriptive_links))
    lines.append(
        f'- Buttons & Interactive Controls: <button>={inspector.buttons_total} (unlabeled={inspector.empty_buttons}), '
        f'clickable <div>/<span>={inspector.clickable_divs}'
    )
    lines.append(
        f'- Form Controls: {inspector.form_controls_total} total | potentially missing <label>/aria-label={len(inspector.unlabeled_controls)}'
    )
    if inspector.unlabeled_controls:
        lines.append('  Controls needing label review: ' + '; '.join(inspector.unlabeled_controls))
    if inspector.tables_total:
        lines.append(f'- Data/Layout Tables: {inspector.tables_total}')

    source_excerpt = _strip_noise_html(html_text)[:16000]
    lines.append('\n=== FETCHED HTML SOURCE EXCERPT ===\n' + source_excerpt)
    return '\n'.join(lines)


def _derive_url_filename(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or 'webpage').lower()
    path = parsed.path.strip('/')
    if not path:
        return f'{host}.html'
    tail = path.split('/')[-1]
    safe_tail = re.sub(r'[^A-Za-z0-9._-]', '_', tail)[:40]
    if '.' not in safe_tail:
        safe_tail += '.html'
    return f'{host}_{safe_tail}'


def fetch_url_for_accessibility(url: str) -> Dict:
    """
    Safely validates and fetches a public HTTP/HTTPS webpage for ALLY WCAG coaching.
    Returns {'ok': True, ...} or {'ok': False, 'rejection': {...}}.
    """
    try:
        _validate_public_url(url)
        opener = urllib.request.build_opener(_SafeRedirectHandler())
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (compatible; ALLY-Accessibility-Coach/1.0)',
                'Accept': 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            method='GET',
        )
        with opener.open(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            status = getattr(resp, 'status', 200) or 200
            final_url = resp.geturl() or url
            _validate_public_url(final_url)
            ctype = (resp.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
            raw_bytes = resp.read(MAX_FETCH_BYTES + 1)
    except _BlockedUrlError as exc:
        return {
            'ok': False,
            'rejection': _build_link_rejection(
                exc.reason_code, exc.title, url, exc.why, exc.technical_detail, exc.how_to_fix
            ),
        }
    except urllib.error.HTTPError as exc:
        code = exc.code
        reason = getattr(exc, 'reason', '') or ''
        how = (
            'Ensure the page URL is publicly accessible without login/paywall or bot blocking. '
            'If the site blocks automated requests (403/401/429), open the page in your browser, save/copy its HTML source, and upload or paste it directly into ALLY.'
        )
        return {
            'ok': False,
            'rejection': _build_link_rejection(
                reason_code=f'HTTP_{code}',
                title=f'Webpage Returned HTTP {code}',
                url=url,
                why=f"The target website refused or failed the request with HTTP {code} ({reason}).",
                technical_detail=f'HTTP status {code} returned when fetching {url}.',
                how_to_fix=how,
            ),
        }
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {
            'ok': False,
            'rejection': _build_link_rejection(
                reason_code='URL_FETCH_FAILED',
                title='Unable to Reach Website URL',
                url=url,
                why='ALLY could not connect to or read a response from that URL within the timeout limit.',
                technical_detail=f'Network/TLS error: {exc}',
                how_to_fix='Verify the URL opens in a public browser without VPN/login, or save the page HTML and upload it to ALLY.',
            ),
        }

    if len(raw_bytes) == 0:
        return {
            'ok': False,
            'rejection': _build_link_rejection(
                reason_code='EMPTY_WEBPAGE_RESPONSE',
                title='Webpage Returned Empty Content',
                url=final_url,
                why='The URL responded with 0 bytes of HTML or readable content.',
                technical_detail=f'HTTP {status} with Content-Length 0 bytes.',
                how_to_fix='Check if the page requires JavaScript login/redirects, or paste the rendered DOM HTML into ALLY.',
            ),
        }

    is_binary_resp = b'\x00' in raw_bytes[:4096]
    allowed_ctypes = ('text/html', 'application/xhtml+xml', 'text/plain', 'application/xml', 'text/xml', 'text/markdown', 'application/json')
    if ctype and not any(ctype == a or ctype.startswith('text/') for a in allowed_ctypes) or is_binary_resp:
        return {
            'ok': False,
            'rejection': _build_link_rejection(
                reason_code='NON_HTML_URL_CONTENT',
                title='URL Points to Binary / Non-Webpage Content',
                url=final_url,
                why=f"This link returned '{ctype or 'binary data'}' rather than an HTML web page.",
                technical_detail=f"Content-Type '{ctype or 'unknown'}' is not an HTML/web document.",
                how_to_fix='Provide a public web page URL (HTML), or download the file (.pdf/.docx) and upload it directly using the attachment button.',
            ),
        }

    if len(raw_bytes) > MAX_FETCH_BYTES:
        raw_bytes = raw_bytes[:MAX_FETCH_BYTES]

    html_text = raw_bytes.decode('utf-8', errors='replace')
    digest = _build_webpage_accessibility_digest(final_url, status, ctype or 'text/html', html_text)
    return {
        'ok': True,
        'url': final_url,
        'file_name': _derive_url_filename(final_url),
        'raw_bytes': raw_bytes,
        'extracted_text': digest,
        'status_code': status,
        'content_type': ctype or 'text/html',
    }


def resolve_url_document(user_message: str = '', explicit_url: str = '') -> Tuple[Optional[Dict], Optional[Dict]]:
    """
    Detects and fetches a target webpage URL from explicit input or user_message.
    Returns (fetched_doc_dict, rejection_chat_payload) — at most one is non-None.
    """
    target_url, pre_rej = extract_target_url(user_message=user_message, explicit_url=explicit_url)
    if pre_rej:
        return None, {
            'type': 'chat',
            'message': pre_rej['message'],
            'rejected': True,
            'rejection_details': pre_rej,
        }
    if not target_url:
        return None, None

    fetched = fetch_url_for_accessibility(target_url)
    if not fetched.get('ok'):
        rej = fetched.get('rejection') or {}
        return None, {
            'type': 'chat',
            'message': rej.get('message', 'Unable to fetch the provided URL.'),
            'rejected': True,
            'rejection_details': rej,
        }
    return fetched, None

