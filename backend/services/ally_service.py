import json
import os
import random
import re
from pathlib import Path
import boto3
from services import guardrail_service

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / '.env')
    load_dotenv()
except ImportError:
    pass


def get_bedrock_client():
    return boto3.client(
        'bedrock-runtime',
        region_name=os.getenv('AWS_DEFAULT_REGION') or os.getenv('AWS_REGION') or 'us-east-1',
    )


MODEL_ID = 'us.amazon.nova-pro-v1:0'
FALLBACK_MODEL_ID = 'us.anthropic.claude-3-haiku-20240307-v1:0'

ALLY_REVIEW_AREAS = [
    'Non-descriptive Links',
    'Heading Hierarchy',
    'Missing Alt Text',
    'Form Labels',
    'Error Messaging',
    'Keyboard Interaction',
    'Reading Order',
    'Color Contrast',
    'Unclear Instructions',
    'Weak Semantics',
    'Button Clarity',
    'Table Structure',
    'Navigation Semantics',
]

ALLY_SYSTEM_PROMPT = """You are ALLY, an Enterprise Web Accessibility Coach ("Open access. Better experience.").
Your core mission is answering: "How can this content or experience become easier for everyone to access and use?"

ALLY acts as a supportive accessibility coach — not simply a mechanical pass/fail checker.
For every concern, present clear, practical guidance structured as: Issue -> Why it matters -> How to improve it (with concrete suggested wording or accessible HTML/JSX markup).

=== ACCESSIBILITY AREAS ALLY CAN REVIEW ===
- Page content & microcopy clarity
- Heading hierarchy (h1 -> h2 -> h3 progression, single clear topic per heading)
- Links ("Click here", "Read more" -> descriptive action + destination, e.g. "View claim details")
- Buttons & accessible control names (icon-only buttons needing aria-label)
- Forms, field labels, required indicators, and grouped fieldsets
- Images and alternative text (meaningful alt vs decorative alt="")
- Tables (caption, <th scope="col|row">)
- Instructions & multi-step guidance (avoiding sensory-only cues like "click the green box on the right")
- Error messages (explaining what failed and exact steps to fix it)
- Navigation structures (<nav>, landmarks, skip links)
- Content semantics (using <button> / <a> / <ul> rather than clickable <div> or <span>)
- Keyboard interaction & reading order considerations
- Color and contrast considerations (visible focus rings, not relying solely on color)

Always remind teams concisely that formal accessibility certification should combine automated testing with assistive-technology and human validation.

You operate dynamically in TWO MODES based on user input:

==================================================
MODE 1: CONVERSATIONAL COACHING & Q&A (type: "chat")
==================================================
Trigger MODE 1 whenever:
- The user greets you, sends casual check-ins ("bro", "thanks", "how are you"), or asks a general accessibility question (e.g., "Why should links avoid 'Click here'?", "What is the difference between a coach and a pass/fail checker?", "How should error messages be written?").
- The user speaks conversationally in any language or asks follow-ups about a previous coaching review.

Respond ONLY with valid JSON:
{
  "type": "chat",
  "message": "<Warm, encouraging, plain-text answer without markdown ** asterisks or disclosing underlying model names>"
}

==================================================
MODE 2: ACCESSIBILITY COACHING REVIEW (type: "accessibility_review")
==================================================
Trigger MODE 2 whenever:
- The user attaches/uploads a file (HTML, JSX, TSX, MD, TXT, PDF, DOCX, CSV, JSON, XML), OR
- The user submits a public website URL (`https://...`) whose HTML & DOM accessibility digest was fetched for coaching, OR
- The user pastes UI code, HTML markup, copy/microcopy (e.g. links, buttons, form instructions, error messages), or asks ALLY to review / audit / improve accessibility.

Respond ONLY with valid JSON matching this exact schema:
{
  "type": "accessibility_review",
  "review_title": "Concise 3-6 word audit title",
  "content_scope": "What is being reviewed (e.g., Claim Portal Links & Form, HTML Snippet, Checkout Copy)",
  "coach_verdict": "STRONG_ACCESSIBILITY" | "NEEDS_COACHING" | "CRITICAL_BARRIERS",
  "readiness_score": 68,
  "coach_summary": "2 warm, constructive sentences highlighting what works well and the highest-impact usability improvements.",
  "metrics": {
    "total_findings": 3,
    "high_priority": 1,
    "medium_priority": 2,
    "elements_reviewed": 5
  },
  "findings": [
    {
      "category": "Non-descriptive Links",
      "priority": "HIGH" | "MEDIUM" | "LOW",
      "element_or_location": "Primary claim link",
      "original_snippet": "Click here",
      "issue": "The link does not explain its purpose when read independently.",
      "why_it_matters": "Screen reader users navigating by links hear only 'Click here' with no context about where it leads.",
      "how_to_improve": "Use specific, action-oriented wording describing the destination.",
      "suggested_fix": "View claim details",
      "wcag_reference": "WCAG 2.1 SC 2.4.4 Link Purpose"
    }
  ],
  "strengths": [
    "Concise encouragement about what is already working or clear"
  ],
  "validation_note": "Formal accessibility certification should still combine automated testing with assistive-technology and human validation."
}

CRITICAL RULES:
- Return ONLY raw valid JSON (no markdown code fences and no ** bold markers in values).
- Never invent code or elements that were not present in the submitted content.
"""

GREETING_REGEX = re.compile(
    r'^\s*(?:hi+|hello+|helo+|hey+|hola+|namaste|ji+|yo+|sup|good\s+(?:morning|afternoon|evening)|how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|thanks?|thank\s+you|ok(?:ay)?|cool|nice|great)\s*[!?.👋🙏]*\s*$',
    re.I,
)

GREETING_RESPONSES = [
    "Hi there! Share HTML, UI copy, links, forms, or upload a page file, and I'll coach you on how to make it clearer and easier for everyone to access and use.",
    "Hello! Ready to review headings, links, alt text, form labels, error messages, or UI markup with Issue -> Why it matters -> How to improve it guidance.",
    "Hey! Drop in a page snippet, button/link wording, or file anytime, and I'll suggest specific accessibility and usability improvements.",
    "Welcome to ALLY! Paste UI copy or upload a web file to get practical, human-first accessibility coaching.",
]

ALLOWED_VERDICTS = {'STRONG_ACCESSIBILITY', 'NEEDS_COACHING', 'CRITICAL_BARRIERS'}
ALLOWED_PRIORITIES = {'HIGH', 'MEDIUM', 'LOW'}


def _pick_non_repeating_greeting(history: list) -> str:
    last_assistant = ''
    for item in reversed(history or []):
        if item.get('role') == 'assistant':
            last_assistant = (item.get('content') or '').strip()
            break
    choices = [g for g in GREETING_RESPONSES if g != last_assistant] or GREETING_RESPONSES
    return random.choice(choices)


def _strip_json_fences(raw_text: str) -> str:
    cleaned = (raw_text or '').strip()
    if cleaned.startswith('```'):
        cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned, flags=re.I)
        cleaned = re.sub(r'\s*```$', '', cleaned)
    start = cleaned.find('{')
    end = cleaned.rfind('}')
    if start != -1 and end > start:
        cleaned = cleaned[start:end + 1]
    return cleaned.strip()


def _deterministic_fallback(text: str, file_name: str = '') -> dict:
    findings = []
    lowered = (text or '').lower()

    vague_link = re.search(r'\b(click\s+here|read\s+more|learn\s+more|here|more\s+info)\b', lowered)
    if vague_link:
        matched = text[vague_link.start():vague_link.end()]
        findings.append({
            'category': 'Non-descriptive Links',
            'priority': 'HIGH',
            'element_or_location': 'Link text',
            'original_snippet': matched,
            'issue': f'The link "{matched}" does not explain its purpose when read independently.',
            'why_it_matters': 'Screen reader users scanning a list of links hear vague text without knowing the destination or action.',
            'how_to_improve': 'Replace generic phrasing with descriptive link text stating what will open or happen.',
            'suggested_fix': 'View claim details',
            'wcag_reference': 'WCAG 2.1 SC 2.4.4 Link Purpose',
        })

    if re.search(r'<img\b(?![^>]*\balt\s*=)[^>]*>', lowered):
        findings.append({
            'category': 'Missing Alt Text',
            'priority': 'HIGH',
            'element_or_location': 'Image element <img>',
            'original_snippet': '<img ...> (without alt)',
            'issue': 'Image element does not define an alt attribute.',
            'why_it_matters': 'Screen readers may read out raw filenames or skip important visual context altogether.',
            'how_to_improve': 'Add descriptive alt text for informative images, or alt="" for purely decorative graphics.',
            'suggested_fix': '<img src="..." alt="Diagram showing the 3-step claim submission flow" />',
            'wcag_reference': 'WCAG 2.1 SC 1.1.1 Non-text Content',
        })

    if re.search(r'<(?:div|span)\b[^>]*\bonclick\s*=', lowered):
        findings.append({
            'category': 'Keyboard Interaction',
            'priority': 'HIGH',
            'element_or_location': 'Clickable <div> or <span>',
            'original_snippet': '<div onClick=...>',
            'issue': 'Interactive control uses a non-semantic container instead of a native button or link.',
            'why_it_matters': 'Keyboard-only and switch-device users cannot focus or activate plain divs with Tab, Enter, or Space by default.',
            'how_to_improve': 'Use a native <button type="button"> for actions or <a href="..."> for navigation.',
            'suggested_fix': '<button type="button" onClick={handleAction}>Submit claim</button>',
            'wcag_reference': 'WCAG 2.1 SC 2.1.1 Keyboard / SC 4.1.2',
        })

    if re.search(r'<input\b(?![^>]*\b(?:aria-label|aria-labelledby|id)\s*=)[^>]*>', lowered):
        findings.append({
            'category': 'Form Labels',
            'priority': 'HIGH',
            'element_or_location': 'Form input field',
            'original_snippet': '<input ...>',
            'issue': 'Input control may lack a programmatically associated <label> or aria-label.',
            'why_it_matters': 'Placeholder text disappears once typing starts and is unreliable for screen reader identification.',
            'how_to_improve': 'Connect a visible <label for="fieldId"> to every form control alongside clear helper instructions.',
            'suggested_fix': '<label for="policyNumber">Policy number</label><input id="policyNumber" type="text" />',
            'wcag_reference': 'WCAG 2.1 SC 1.3.1 / SC 3.3.2 Labels or Instructions',
        })

    if re.search(r'\b(invalid\s+input|error\s+occurred|something\s+went\s+wrong|bad\s+request)\b', lowered):
        findings.append({
            'category': 'Error Messaging',
            'priority': 'MEDIUM',
            'element_or_location': 'Validation feedback',
            'original_snippet': 'Invalid input / Error occurred',
            'issue': 'Error message reports a failure without explaining which field failed or how to correct it.',
            'why_it_matters': 'Users—especially people using magnification, cognitive aids, or screen readers—need specific recovery guidance.',
            'how_to_improve': 'State what went wrong and provide an example of valid input right beside the field.',
            'suggested_fix': 'Enter your 8-digit policy number using numbers only (for example, 10492831).',
            'wcag_reference': 'WCAG 2.1 SC 3.3.1 / SC 3.3.3 Error Suggestion',
        })

    headings = [int(h) for h in re.findall(r'<h([1-6])\b', lowered)]
    if headings and any(headings[i] - headings[i - 1] > 1 for i in range(1, len(headings))):
        findings.append({
            'category': 'Heading Hierarchy',
            'priority': 'MEDIUM',
            'element_or_location': 'Page headings',
            'original_snippet': ' -> '.join(f'h{h}' for h in headings[:5]),
            'issue': 'Heading levels skip one or more ranks (for example jumping from h1 straight to h3).',
            'why_it_matters': 'Assistive tech users rely on sequential heading levels to build a mental outline of the page.',
            'how_to_improve': 'Step headings sequentially (h1 -> h2 -> h3) and style visual sizes with CSS rather than skipping levels.',
            'suggested_fix': 'Use <h2> for top section headings under <h1>, and <h3> for subsections.',
            'wcag_reference': 'WCAG 2.1 SC 1.3.1 Info and Relationships',
        })

    if not findings:
        findings.append({
            'category': 'Content Semantics',
            'priority': 'LOW',
            'element_or_location': file_name or 'Submitted content',
            'original_snippet': (text or '').strip()[:140],
            'issue': 'Review heading structure, link clarity, and interactive focus order across the complete experience.',
            'why_it_matters': 'Even clean short snippets depend on surrounding landmarks, contrast, and keyboard navigation.',
            'how_to_improve': 'Pair clear plain-language copy with semantic HTML landmarks (<main>, <nav>, <button>) and visible focus states.',
            'suggested_fix': 'Ensure every link, button, and form field clearly communicates its action and state.',
            'wcag_reference': 'WCAG 2.1 POUR Principles',
        })

    high_cnt = sum(1 for f in findings if f['priority'] == 'HIGH')
    med_cnt = sum(1 for f in findings if f['priority'] == 'MEDIUM')
    verdict = 'CRITICAL_BARRIERS' if high_cnt >= 2 else ('NEEDS_COACHING' if (high_cnt + med_cnt) > 0 else 'STRONG_ACCESSIBILITY')
    score = max(35, min(95, 92 - high_cnt * 18 - med_cnt * 9))

    return {
        'type': 'accessibility_review',
        'review_title': f'{file_name} Accessibility Review' if file_name else 'Accessibility Coaching Review',
        'content_scope': file_name or 'Submitted UI / Content Snippet',
        'coach_verdict': verdict,
        'readiness_score': score,
        'coach_summary': (
            f'Identified {len(findings)} accessibility coaching opportunities focused on making links, interactions, and wording clearer for everyone. '
            'Applying these targeted improvements builds stronger screen reader, keyboard, and cognitive usability.'
        ),
        'metrics': {
            'total_findings': len(findings),
            'high_priority': high_cnt,
            'medium_priority': med_cnt,
            'elements_reviewed': max(1, len(findings) + 2),
        },
        'findings': findings,
        'strengths': ['Content submitted early for proactive accessibility coaching.'],
        'validation_note': 'Formal accessibility certification should still combine automated testing with assistive-technology and human validation.',
    }


def _normalize_review(payload: dict, fallback_scope: str) -> dict:
    raw_findings = payload.get('findings')
    if not isinstance(raw_findings, list):
        raw_findings = []

    findings = []
    for item in raw_findings[:16]:
        if not isinstance(item, dict):
            continue
        prio = str(item.get('priority') or 'MEDIUM').strip().upper()
        if prio not in ALLOWED_PRIORITIES:
            prio = 'MEDIUM'
        findings.append({
            'category': str(item.get('category') or 'Content Semantics').strip(),
            'priority': prio,
            'element_or_location': str(item.get('element_or_location') or 'Submitted element').strip(),
            'original_snippet': str(item.get('original_snippet') or '').strip(),
            'issue': str(item.get('issue') or 'Accessibility clarity can be strengthened.').strip(),
            'why_it_matters': str(item.get('why_it_matters') or 'Affects comprehension for assistive-tech and keyboard users.').strip(),
            'how_to_improve': str(item.get('how_to_improve') or 'Provide explicit semantic structure and descriptive wording.').strip(),
            'suggested_fix': str(item.get('suggested_fix') or '').strip(),
            'wcag_reference': str(item.get('wcag_reference') or 'WCAG 2.1 AA').strip(),
        })

    high_cnt = sum(1 for f in findings if f['priority'] == 'HIGH')
    med_cnt = sum(1 for f in findings if f['priority'] == 'MEDIUM')

    verdict = str(payload.get('coach_verdict') or '').strip().upper()
    if verdict not in ALLOWED_VERDICTS:
        if high_cnt >= 2:
            verdict = 'CRITICAL_BARRIERS'
        elif high_cnt + med_cnt > 0:
            verdict = 'NEEDS_COACHING'
        else:
            verdict = 'STRONG_ACCESSIBILITY'

    try:
        score = int(payload.get('readiness_score'))
    except Exception:
        score = max(35, min(95, 92 - high_cnt * 15 - med_cnt * 8))
    score = max(0, min(100, score))

    metrics = payload.get('metrics') if isinstance(payload.get('metrics'), dict) else {}
    total_findings = len(findings)
    elements_reviewed = int(metrics.get('elements_reviewed') or max(1, total_findings + 2))

    strengths = payload.get('strengths')
    if not isinstance(strengths, list) or not strengths:
        strengths = ['Focused review targeting real-world comprehension and assistive technology support.']

    validation_note = str(
        payload.get('validation_note')
        or 'Formal accessibility certification should still combine automated testing with assistive-technology and human validation.'
    ).strip()

    return {
        'type': 'accessibility_review',
        'review_title': str(payload.get('review_title') or 'Web Accessibility Coaching Review').strip(),
        'content_scope': str(payload.get('content_scope') or fallback_scope or 'Web Content & UI').strip(),
        'coach_verdict': verdict,
        'readiness_score': score,
        'coach_summary': str(payload.get('coach_summary') or '').strip(),
        'metrics': {
            'total_findings': total_findings,
            'high_priority': high_cnt,
            'medium_priority': med_cnt,
            'elements_reviewed': elements_reviewed,
        },
        'findings': findings,
        'strengths': [str(s).strip() for s in strengths[:6] if str(s).strip()],
        'validation_note': validation_note,
    }


def _invoke_bedrock(client, model_id: str, messages: list) -> str:
    response = client.converse(
        modelId=model_id,
        system=[{'text': ALLY_SYSTEM_PROMPT}],
        messages=messages,
        inferenceConfig={'maxTokens': 2400, 'temperature': 0.15},
    )
    parts = response.get('output', {}).get('message', {}).get('content', [])
    return ''.join(p.get('text', '') for p in parts if isinstance(p, dict))


def _looks_like_review_request(text: str) -> bool:
    if not text:
        return False
    lowered = text.lower()
    if any(tag in lowered for tag in ('<a ', '<button', '<img', '<input', '<form', '<h1', '<h2', '<h3', '<div', '<nav', '<label', '<table', 'aria-', 'onclick')):
        return True
    if any(kw in lowered for kw in ('click here', 'read more', 'learn more', 'invalid input', 'alt text', 'wcag', 'screen reader')):
        return True
    if re.search(r'\b(?:review|audit|check|improve|accessibility|accessible|fix|evaluate|coach)\b', lowered) and (len(text) > 35 or ':' in text or '"' in text or "'" in text):
        return True
    return False


def review_or_chat(
    user_message: str,
    history: list = None,
    document_text: str = '',
    file_name: str = '',
    source_url: str = '',
) -> dict:
    clean_msg = guardrail_service.sanitize_prompt(user_message)
    safe_history = guardrail_service.build_safe_history(history or [])
    has_doc = bool((document_text or '').strip())

    msg_guard = guardrail_service.inspect_and_sanitize(clean_msg, is_document=False)
    if msg_guard.get('blocked'):
        return {
            'type': 'chat',
            'message': msg_guard.get('message', 'Request blocked by Enterprise BFSI Security Guardrails.'),
            'guardrails': msg_guard.get('guardrails'),
            'rejected': True,
        }
    clean_msg = msg_guard.get('sanitized_text', clean_msg)
    if has_doc:
        doc_guard = guardrail_service.inspect_and_sanitize(document_text, is_document=True)
        if doc_guard.get('blocked'):
            return {
                'type': 'chat',
                'message': doc_guard.get('message', 'Document blocked by Enterprise BFSI Security Guardrails.'),
                'guardrails': doc_guard.get('guardrails'),
                'rejected': True,
            }
        document_text = doc_guard.get('sanitized_text', document_text)

    if not has_doc and clean_msg and GREETING_REGEX.match(clean_msg):
        return {'type': 'chat', 'message': _pick_non_repeating_greeting(safe_history)}

    if has_doc:
        source_label = f'FETCHED WEBPAGE ({source_url})' if source_url else f"UPLOADED CONTENT ({file_name or 'document'})"
        combined_user_text = (
            f"User instruction: {clean_msg or 'Please perform an accessibility coaching review of this content and suggest actionable improvements.'}\n\n"
            f"=== {source_label} ===\n{document_text[:28000]}"
        )
    else:
        combined_user_text = clean_msg

    bedrock_messages = []
    for m in safe_history:
        bedrock_messages.append({'role': m['role'], 'content': [{'text': m['content']}]})
    bedrock_messages.append({'role': 'user', 'content': [{'text': combined_user_text}]})

    raw_output = None
    client = get_bedrock_client()
    for mid in (MODEL_ID, FALLBACK_MODEL_ID):
        try:
            raw_output = _invoke_bedrock(client, mid, bedrock_messages)
            if raw_output:
                break
        except Exception:
            continue

    fallback_scope = file_name or 'Submitted UI / Content'
    if raw_output:
        try:
            parsed = json.loads(_strip_json_fences(raw_output))
            if isinstance(parsed, dict):
                if parsed.get('type') == 'accessibility_review' or 'findings' in parsed:
                    return _normalize_review(parsed, fallback_scope)
                if parsed.get('type') == 'chat' and parsed.get('message'):
                    return {'type': 'chat', 'message': str(parsed['message']).strip()}
        except Exception:
            pass
        if not has_doc and not _looks_like_review_request(clean_msg):
            return {'type': 'chat', 'message': raw_output.strip()[:2500]}

    if has_doc or _looks_like_review_request(clean_msg):
        return _deterministic_fallback(document_text or clean_msg, file_name)

    return {
        'type': 'chat',
        'message': "Share a public webpage link (https://...), HTML markup, UI copy (links, headings, form labels, or error messages), or attach a file so I can coach you through clear accessibility improvements.",
    }

