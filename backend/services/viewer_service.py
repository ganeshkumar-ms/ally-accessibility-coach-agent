import html


def build_viewer_html(file_name: str, extracted_text: str) -> str:
    safe_name = html.escape(file_name or 'source.html')
    safe_text = html.escape(extracted_text or '(No extractable text found)')
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ALLY — {safe_name}</title>
<style>
  body {{
    margin: 0;
    padding: 24px;
    background: #031107;
    color: #e9f9ee;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.65;
  }}
  .top {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 14px;
    margin-bottom: 18px;
    border-bottom: 1px solid rgba(0, 218, 75, 0.25);
  }}
  .badge {{
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.4px;
    color: #5fffa0;
    background: rgba(0, 218, 75, 0.14);
    border: 1px solid rgba(0, 218, 75, 0.36);
    padding: 4px 10px;
    border-radius: 999px;
  }}
  .fname {{
    font-size: 15px;
    font-weight: 600;
    color: #ffffff;
  }}
  pre {{
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    background: rgba(8, 37, 15, 0.72);
    border: 1px solid rgba(0, 218, 75, 0.20);
    border-radius: 14px;
    padding: 18px;
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 13.5px;
    line-height: 1.7;
    color: #dcfce7;
  }}
</style>
</head>
<body>
  <div class="top">
    <span class="fname">{safe_name}</span>
    <span class="badge">ALLY CONTENT SOURCE</span>
  </div>
  <pre>{safe_text}</pre>
</body>
</html>"""

