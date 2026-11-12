import base64
import os
import re
import uuid
import boto3
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

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


class ReviewRequest(BaseModel):
    message: Optional[str] = ''
    history: Optional[List[dict]] = []
    file_name: Optional[str] = None
    file_content_base64: Optional[str] = None
    s3_key: Optional[str] = None
    url: Optional[str] = None


class UploadUrlRequest(BaseModel):
    file_name: str
    content_type: Optional[str] = 'application/octet-stream'


def _read_s3_bytes(key: str) -> bytes:
    if not S3_BUCKET or not key:
        raise HTTPException(status_code=400, detail='S3 storage is not configured')
    s3 = boto3.client('s3', region_name=os.getenv('AWS_REGION') or 'us-east-1')
    obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
    return obj['Body'].read()


@app.get('/api/health')
def health():
    return {'status': 'healthy', 'service': 'ALLY WEB ACCESSIBILITY COACH'}


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


@app.post('/api/review')
@app.post('/api/chat')
def review(req: ReviewRequest):
    doc_text = ''
    fname = req.file_name or ''
    raw_bytes = b''
    has_upload = bool(fname) or (req.file_content_base64 is not None) or bool(req.s3_key)
    if req.file_content_base64:
        payload = req.file_content_base64.split(',', 1)[-1]
        raw_bytes = base64.b64decode(payload)
    elif req.s3_key:
        raw_bytes = _read_s3_bytes(req.s3_key)
        fname = fname or req.s3_key.split('/')[-1]

    if has_upload:
        pre_rej = file_validation.validate_file_pre_extract(fname or 'uploaded_file', raw_bytes)
        if pre_rej:
            return {
                'type': 'chat',
                'message': pre_rej['message'],
                'rejected': True,
                'rejection_details': pre_rej,
                'file_name': fname,
            }

    if raw_bytes:
        doc_text = document_service.extract_document_text(raw_bytes, fname or 'content.html')
    if has_upload:
        post_rej = file_validation.validate_file_post_extract(fname or 'uploaded_file', raw_bytes, doc_text)
        if post_rej:
            return {
                'type': 'chat',
                'message': post_rej['message'],
                'rejected': True,
                'rejection_details': post_rej,
                'file_name': fname,
            }

    source_url = ''
    if not has_upload:
        url_doc, url_rej = url_service.resolve_url_document(
            user_message=req.message or '',
            explicit_url=req.url or '',
        )
        if url_rej:
            return url_rej
        if url_doc:
            doc_text = url_doc['extracted_text']
            fname = url_doc['file_name']
            raw_bytes = url_doc['raw_bytes']
            source_url = url_doc['url']

    result = ally_service.review_or_chat(
        user_message=req.message or '',
        history=req.history or [],
        document_text=doc_text,
        file_name=fname,
        source_url=source_url,
    )
    if raw_bytes:
        result['file_name'] = fname
        if source_url:
            result['source_url'] = source_url
        result['extracted_text'] = doc_text[:15000]
        result['viewer_html'] = viewer_service.build_viewer_html(fname, doc_text)
    return result

