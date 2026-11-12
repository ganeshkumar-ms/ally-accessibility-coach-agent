import argparse
import base64
import json
import sys
import urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def req_json(url: str, payload: dict = None) -> dict:
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    headers = {'Content-Type': 'application/json'} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if payload is not None else 'GET')
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode('utf-8'))


def run_suite(base_url: str, check_root_html: bool = False):
    base = base_url.rstrip('/')
    if check_root_html:
        with urllib.request.urlopen(base + '/', timeout=15) as r:
            html = r.read().decode('utf-8')
        assert r.status == 200 and 'id="root"' in html, f'Root HTML check failed: {r.status}'
        print('CloudFront root HTML HTTP 200 PASS')

    print(f'\n--- Testing ALLY End-to-End: {base} ---')

    # [1/6] Health
    h = req_json(f'{base}/api/health')
    assert h.get('status') == 'healthy' and 'ALLY' in (h.get('service') or ''), f'Health failed: {h}'
    print(f"  [1/6] /api/health PASS: {h['service']}")

    # [2/6] Consecutive greetings varied & zero raw ** markdown
    g_replies = []
    hist = []
    for g in ['hi', 'hello', 'hey']:
        res = req_json(f'{base}/api/review', {'message': g, 'history': hist})
        assert res.get('type') == 'chat' and res.get('message'), f'Greeting failed: {res}'
        assert '**' not in res['message'], f'Unexpected ** in greeting: {res}'
        g_replies.append(res['message'])
        hist.extend([{'role': 'user', 'content': g}, {'role': 'assistant', 'content': res['message']}])
    assert len(set(g_replies)) >= 2, f'Repeated identical greetings: {g_replies}'
    print(f'  [2/6] Consecutive Greetings Varied PASS ({len(set(g_replies))} unique): {g_replies[0][:65]}')

    # [3/6] Conversational Mode 1
    chat = req_json(f'{base}/api/review', {'message': 'Why should links avoid saying Click here for screen reader users?'})
    assert chat.get('type') == 'chat' and len(chat.get('message', '')) > 20, f'Chat failed: {chat}'
    print(f"  [3/6] Conversational Mode 1 PASS: {chat['message'][:75]}")

    # [4/6] Microcopy Link Coaching (Spec Example: "Click here")
    link_audit = req_json(
        f'{base}/api/review',
        {
            'message': 'Review this link wording on our claims portal: "Click here" and error message "Invalid input".'
        },
    )
    assert link_audit.get('type') == 'accessibility_review' and link_audit.get('findings'), f'Link audit failed: {link_audit}'
    assert link_audit.get('validation_note'), f'Missing validation_note: {link_audit}'
    print(f"  [4/6] Link/Microcopy Coaching PASS: {link_audit.get('coach_verdict')} score={link_audit.get('readiness_score')} ({len(link_audit['findings'])} findings)")

    # [5/6] HTML File Upload Audit + Document Viewer
    bad_html = (
        '<main>\n'
        '  <h1>Submit Policy Claim</h1>\n'
        '  <h3>Claim Form</h3>\n'
        '  <img src="/banner.png" />\n'
        '  <input type="text" placeholder="Enter policy #" />\n'
        '  <div onclick="submitClaim()">Click here</div>\n'
        '</main>'
    )
    file_audit = req_json(
        f'{base}/api/review',
        {
            'message': 'Audit this page HTML and coach our team on how to improve accessibility.',
            'file_name': 'claim_portal_draft.html',
            'file_content_base64': base64.b64encode(bad_html.encode('utf-8')).decode('ascii'),
        },
    )
    assert file_audit.get('type') == 'accessibility_review' and len(file_audit.get('findings', [])) >= 2, f'HTML audit failed: {file_audit}'
    assert 'ALLY CONTENT SOURCE' in (file_audit.get('viewer_html') or ''), f'Viewer HTML missing: {file_audit}'
    print(
        f"  [5/6] HTML File Upload + Viewer PASS: {file_audit.get('coach_verdict')} "
        f"({len(file_audit['findings'])} findings, score={file_audit.get('readiness_score')})"
    )

    # [6/6] Clean accessible snippet check
    good_html = (
        '<main>\n'
        '  <h1>Claim Status Portal</h1>\n'
        '  <h2>Verify Your Policy</h2>\n'
        '  <label for="pol">8-digit policy number</label>\n'
        '  <input id="pol" type="text" aria-describedby="polHint" />\n'
        '  <p id="polHint">Example: 10492831</p>\n'
        '  <a href="/claim/details">View claim details</a>\n'
        '</main>'
    )
    good_res = req_json(
        f'{base}/api/review',
        {'message': f'Review this updated HTML component:\n{good_html}'},
    )
    assert good_res.get('type') == 'accessibility_review' and good_res.get('readiness_score', 0) >= 65, f'Good HTML check unexpected: {good_res}'
    print(f"  [6/8] Clean Accessible HTML Coaching PASS: {good_res.get('coach_verdict')} score={good_res.get('readiness_score')}")

    # [7/8] Live Public Webpage URL Audit
    url_res = req_json(
        f'{base}/api/review',
        {'message': 'Audit accessibility of https://example.com'},
    )
    assert url_res.get('type') == 'accessibility_review' and url_res.get('source_url'), f'URL audit failed: {url_res}'
    assert url_res.get('viewer_html') and len(url_res.get('findings', [])) >= 1, f'URL viewer/findings missing: {url_res}'
    print(f"  [7/8] Public URL Accessibility Audit PASS: {url_res.get('source_url')} -> {url_res.get('coach_verdict')} score={url_res.get('readiness_score')}")

    # [8/8] Private/SSRF URL Detailed Rejection
    bad_url_res = req_json(
        f'{base}/api/review',
        {'message': 'http://169.254.169.254/latest/meta-data/'},
    )
    assert bad_url_res.get('type') == 'chat' and bad_url_res.get('rejected') is True, f'SSRF block failed: {bad_url_res}'
    assert bad_url_res.get('rejection_details', {}).get('reason_code') == 'PRIVATE_OR_LOCAL_URL_BLOCKED', bad_url_res
    assert 'Link Not Accepted' in bad_url_res.get('message', '')
    print('  [8/8] Private/Local URL SSRF Detailed Rejection PASS')
    print('\nALL ALLY TESTS PASSED!\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--api', default='')
    parser.add_argument('--cf', default='')
    args = parser.parse_args()
    if args.api:
        run_suite(args.api, check_root_html=False)
    if args.cf:
        run_suite(args.cf, check_root_html=True)

