import base64
import json
import os
import re
import uuid
import boto3
from botocore.config import Config
from urllib.parse import unquote

from services import ally_service, document_service, file_validation, url_service, viewer_service

REGION = os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
S3_BUCKET = os.environ.get('ALLY_DOCS_BUCKET') or os.environ.get('S3_BUCKET_NAME') or ''

s3_client = boto3.client(
    's3',
    region_name=REGION,
    endpoint_url=f'https://s3.{REGION}.amazonaws.com',
    config=Config(signature_version='s3v4', s3={'addressing_style': 'virtual'}),
)

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
}


def _json_response(status_code: int, payload: dict) -> dict:
    return {
        'statusCode': status_code,
        'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
        'body': json.dumps(payload),
    }


def _read_s3_bytes(key: str) -> bytes:
    if not S3_BUCKET or not key:
        raise ValueError('S3 storage is not configured')
    obj = s3_client.get_object(Bucket=S3_BUCKET, Key=key)
    return obj['Body'].read()


def lambda_handler(event, context):
    method = (
        event.get('requestContext', {}).get('http', {}).get('method')
        or event.get('httpMethod')
        or 'GET'
    ).upper()

    raw_path = (
        event.get('requestContext', {}).get('http', {}).get('path')
        or event.get('rawPath')
        or event.get('path')
        or '/'
    )

    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    if method == 'GET' and raw_path in ('/api/health', '/health'):
        return _json_response(200, {'status': 'healthy', 'service': 'ALLY WEB ACCESSIBILITY COACH'})

    if method == 'GET' and raw_path == '/api/view-document':
        qs = event.get('queryStringParameters') or {}
        s3_key = unquote(qs.get('s3_key', ''))
        file_name = qs.get('file_name') or (s3_key.split('/')[-1] if s3_key else 'content.html')
        try:
            raw = _read_s3_bytes(s3_key)
            text = document_service.extract_document_text(raw, file_name)
            return _json_response(200, {
                'file_name': file_name,
                'extracted_text': text,
                'viewer_html': viewer_service.build_viewer_html(file_name, text),
            })
        except Exception as exc:
            return _json_response(400, {'detail': str(exc)})

    body = {}
    raw_body = event.get('body') or ''
    if raw_body:
        if event.get('isBase64Encoded'):
            raw_body = base64.b64decode(raw_body).decode('utf-8', errors='replace')
        try:
            body = json.loads(raw_body)
        except Exception:
            body = {}

    if method == 'POST' and raw_path == '/api/get-upload-url':
        if not S3_BUCKET:
            return _json_response(500, {'detail': 'Upload bucket not configured'})
        file_name = body.get('file_name') or 'content.html'
        content_type = body.get('content_type') or 'application/octet-stream'
        safe_name = re.sub(r'[^A-Za-z0-9._-]', '_', file_name)
        key = f'uploads/{uuid.uuid4().hex}_{safe_name}'
        upload_url = s3_client.generate_presigned_url(
            'put_object',
            Params={'Bucket': S3_BUCKET, 'Key': key, 'ContentType': content_type},
            ExpiresIn=300,
        )
        return _json_response(200, {'upload_url': upload_url, 's3_key': key, 'file_name': safe_name})

    if method == 'POST' and raw_path in ('/api/review', '/api/chat', '/api/analyze', '/api/message'):
        try:
            fname = body.get('file_name') or ''
            raw_bytes = b''
            has_upload = bool(fname) or ('file_content_base64' in body) or bool(body.get('s3_key'))
            if body.get('file_content_base64'):
                payload = str(body['file_content_base64']).split(',', 1)[-1]
                raw_bytes = base64.b64decode(payload)
            elif body.get('s3_key'):
                raw_bytes = _read_s3_bytes(body['s3_key'])
                fname = fname or body['s3_key'].split('/')[-1]

            if has_upload:
                pre_rej = file_validation.validate_file_pre_extract(fname or 'uploaded_file', raw_bytes)
                if pre_rej:
                    return _json_response(200, {
                        'type': 'chat',
                        'message': pre_rej['message'],
                        'rejected': True,
                        'rejection_details': pre_rej,
                        'file_name': fname,
                    })

            doc_text = document_service.extract_document_text(raw_bytes, fname or 'content.html') if raw_bytes else ''
            if has_upload:
                post_rej = file_validation.validate_file_post_extract(fname or 'uploaded_file', raw_bytes, doc_text)
                if post_rej:
                    return _json_response(200, {
                        'type': 'chat',
                        'message': post_rej['message'],
                        'rejected': True,
                        'rejection_details': post_rej,
                        'file_name': fname,
                    })
            source_url = ''
            if not has_upload:
                url_doc, url_rej = url_service.resolve_url_document(
                    user_message=body.get('message') or '',
                    explicit_url=body.get('url') or '',
                )
                if url_rej:
                    return _json_response(200, url_rej)
                if url_doc:
                    doc_text = url_doc['extracted_text']
                    fname = url_doc['file_name']
                    raw_bytes = url_doc['raw_bytes']
                    source_url = url_doc['url']

            result = ally_service.review_or_chat(
                user_message=body.get('message') or '',
                history=body.get('history') or [],
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
            return _json_response(200, result)
        except Exception as exc:
            return _json_response(500, {'detail': str(exc)})

    return _json_response(404, {'detail': f'Route not found: {method} {raw_path}'})

