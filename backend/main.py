import base64
import os
import re
import uuid
from pathlib import Path
from typing import List, Optional
import boto3
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services import ally_service, document_service, file_validation, url_service, viewer_service

app = FastAPI(title='ALLY Web Accessibility Coach API')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)

S3_BUCKET = os.getenv('ALLY_DOCS_BUCKET') or os.getenv('S3_BUCKET_NAME') or ''


class DocumentItem(BaseModel):
    name: str
    content_base64: Optional[str] = None
    s3_key: Optional[str] = None
    extracted_text: Optional[str] = None


class ReviewRequest(BaseModel):
    message: Optional[str] = ''
    history: Optional[List[dict]] = []
    file_name: Optional[str] = None
    file_content_base64: Optional[str] = None
    s3_key: Optional[str] = None
    url: Optional[str] = None
    documents: Optional[List[DocumentItem]] = []


class UploadUrlRequest(BaseModel):
    file_name: str
    content_type: Optional[str] = 'application/octet-stream'


class ScanPathRequest(BaseModel):
    folder_path: str


def _read_s3_bytes(key: str) -> bytes:
    if not S3_BUCKET or not key:
        raise HTTPException(status_code=400, detail='S3 storage is not configured')
    s3 = boto3.client('s3', region_name=os.getenv('AWS_REGION') or 'us-east-1')
    obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
    return obj['Body'].read()


@app.get('/')
@app.get('/health')
@app.get('/api/health')
def health():
    return {'status': 'healthy', 'agent': 'ALLY', 'eyebrow': 'WEB ACCESSIBILITY COACH', 'service': 'ALLY WEB ACCESSIBILITY COACH'}


@app.post('/api/get-upload-url')
def get_upload_url(req: UploadUrlRequest):
    if not S3_BUCKET:
        raise HTTPException(status_code=500, detail='Upload bucket not configured')
    safe_name = re.sub(r'[^A-Za-z0-9._-]', '_', req.file_name or 'content.html')
    key = f'uploads/{uuid.uuid4().hex}_{safe_name}'
    s3 = boto3.client('s3', region_name=os.getenv('AWS_REGION') or 'us-east-1')
    url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': S3_BUCKET, 'Key': key, 'ContentType': req.content_type or 'application/octet-stream'},
        ExpiresIn=300,
    )
    return {'upload_url': url, 's3_key': key, 'file_name': safe_name}


@app.get('/api/view-document')
def view_document(s3_key: str, file_name: Optional[str] = None):
    raw = _read_s3_bytes(s3_key)
    name = file_name or s3_key.split('/')[-1]
    text = document_service.extract_document_text(raw, name)
    return {
        'file_name': name,
        'extracted_text': text,
        'viewer_html': viewer_service.build_viewer_html(name, text),
    }


@app.post('/api/scan-path')
def scan_path(req: ScanPathRequest):
    folder_str = req.folder_path.strip().strip('"').strip("'")
    p = Path(folder_str)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Location does not exist: {folder_str}")
    allowed_exts = {
        '.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts', '.css',
        '.md', '.txt', '.pdf', '.docx', '.json', '.xml'
    }
    files_found = []
    candidates = [p] if p.is_file() else list(p.glob('**/*'))
    for f in candidates:
        if len(files_found) >= 30:
            break
        if f.is_file() and f.suffix.lower() in allowed_exts:
            # skip node_modules, .git, venv, dist
            parts = f.parts
            if any(p in parts for p in ('node_modules', '.git', 'venv', '.venv', 'dist', 'build', '__pycache__')):
                continue
            try:
                raw = f.read_bytes()
                txt = document_service.extract_document_text(raw, f.name)
                files_found.append({
                    'name': f.name,
                    'extracted_text': txt,
                    'file_size': len(raw),
                    'path': str(f),
                })
            except Exception:
                continue
    return {'folder_path': str(p), 'total_files': len(files_found), 'files': files_found}


@app.post('/api/review')
@app.post('/api/chat')
def review(req: ReviewRequest):
    # Collect all items (either multi-document list or single upload)
    items: List[DocumentItem] = list(req.documents or [])
    if not items and (req.file_name or (req.file_content_base64 is not None) or req.s3_key):
        items.append(DocumentItem(
            name=req.file_name or 'content.html',
            content_base64=req.file_content_base64,
            s3_key=req.s3_key,
        ))

    resolved_docs = []
    quarantined_files = []

    for item in items[:25]:
        fname = item.name or 'content.html'
        raw_bytes = b''
        doc_text = ''

        if item.extracted_text:
            doc_text = str(item.extracted_text)[:45000]
            resolved_docs.append({
                'name': fname,
                'text': doc_text,
                'raw_bytes': b'',
                'file_size': len(doc_text),
            })
            continue

        if item.content_base64:
            try:
                payload = item.content_base64.split(',', 1)[-1]
                raw_bytes = base64.b64decode(payload)
            except Exception as e:
                quarantined_files.append({
                    'name': fname,
                    'reason': f"Could not decode base64 file payload: {str(e)}",
                    'details': {'why': 'Corrupt base64 upload payload'}
                })
                continue
        elif item.s3_key:
            try:
                raw_bytes = _read_s3_bytes(item.s3_key)
            except Exception as e:
                quarantined_files.append({
                    'name': fname,
                    'reason': f"Failed to retrieve file from S3: {str(e)}",
                    'details': {'why': 'S3 object retrieval failed'}
                })
                continue

        if not raw_bytes:
            continue

        # Guardrail / Format Validation with Quarantine Fault Tolerance
        pre_rej = file_validation.validate_file_pre_extract(fname, raw_bytes)
        if pre_rej:
            quarantined_files.append({
                'name': fname,
                'reason': pre_rej.get('message') or pre_rej.get('reason') or pre_rej.get('why') or 'File rejected by pre-extraction policy',
                'details': pre_rej,
            })
            continue

        doc_text = document_service.extract_document_text(raw_bytes, fname)
        post_rej = file_validation.validate_file_post_extract(fname, raw_bytes, doc_text)
        if post_rej:
            quarantined_files.append({
                'name': fname,
                'reason': post_rej.get('message') or post_rej.get('reason') or post_rej.get('why') or 'Content validation policy violation',
                'details': post_rej,
            })
            continue

        resolved_docs.append({
            'name': fname,
            'text': doc_text,
            'raw_bytes': raw_bytes,
            'file_size': len(raw_bytes),
        })

    # If all items failed guardrails and no valid docs remain, return rejection
    if not resolved_docs and quarantined_files:
        first_q = quarantined_files[0]
        rej = first_q.get('details') or {}
        return {
            'type': 'chat',
            'message': first_q['reason'],
            'rejected': True,
            'rejection_details': rej,
            'file_name': first_q['name'],
            'quarantined_files': quarantined_files,
        }

    # URL Fallback if no files provided
    source_url = ''
    primary_fname = ''
    primary_text = ''
    primary_bytes = b''

    if resolved_docs:
        primary_fname = resolved_docs[0]['name']
        primary_bytes = resolved_docs[0]['raw_bytes']
        if len(resolved_docs) == 1:
            primary_text = resolved_docs[0]['text']
        else:
            # Multi-file consolidated context
            chunks = []
            for d in resolved_docs:
                chunks.append(f"=== FILE: {d['name']} ===\n{d['text'][:12000]}")
            primary_text = '\n\n'.join(chunks)
            primary_fname = f"Batch Collection ({len(resolved_docs)} files)"
    elif not items:
        url_doc, url_rej = url_service.resolve_url_document(
            user_message=req.message or '',
            explicit_url=req.url or '',
        )
        if url_rej:
            return url_rej
        if url_doc:
            primary_text = url_doc['extracted_text']
            primary_fname = url_doc['file_name']
            primary_bytes = url_doc['raw_bytes']
            source_url = url_doc['url']

    result = ally_service.review_or_chat(
        user_message=req.message or '',
        history=req.history or [],
        document_text=primary_text,
        file_name=primary_fname,
        source_url=source_url,
    )

    if quarantined_files:
        result['quarantined_files'] = quarantined_files

    if primary_bytes or primary_text:
        result['file_name'] = primary_fname
        if source_url:
            result['source_url'] = source_url
        result['extracted_text'] = primary_text[:15000]
        result['viewer_html'] = viewer_service.build_viewer_html(primary_fname, primary_text)
        result['doc_list'] = [{'name': d['name'], 'file_size': d['file_size']} for d in resolved_docs]

    return result
