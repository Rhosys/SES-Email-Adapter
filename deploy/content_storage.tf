# ---------------------------------------------------------------------------
# S3 — extracted content (attachments, sanitized images)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "extracted_content" {
  bucket           = "${lower(var.service_name)}-content-${var.aws_account_id}-${data.aws_region.current.id}-an"
  bucket_namespace = "account-regional"
}

resource "aws_s3_bucket_public_access_block" "extracted_content" {
  bucket                  = aws_s3_bucket.extracted_content.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "extracted_content" {
  bucket = aws_s3_bucket.extracted_content.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "extracted_content" {
  bucket = aws_s3_bucket.extracted_content.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  rule {
    id     = "expire-1-year"
    status = "Enabled"
    filter {
      tag {
        key   = "retention"
        value = "365"
      }
    }
    expiration { days = 365 }
  }

  rule {
    id     = "expire-10-years"
    status = "Enabled"
    filter {
      tag {
        key   = "retention"
        value = "3650"
      }
    }
    expiration { days = 3650 }
  }

  # Objects with no retention tag live forever (no expiration rule matches)
}

resource "aws_s3_bucket_policy" "extracted_content" {
  bucket = aws_s3_bucket.extracted_content.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.extracted_content.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.api.arn }
      }
    }]
  })
}
