-- Feature migration3 is installed after media tables, on both fresh and upgraded databases.
ALTER TABLE longball.media_uploads DROP CONSTRAINT media_uploads_declared_mime_check;
ALTER TABLE longball.media_uploads ADD CONSTRAINT media_uploads_declared_mime_check CHECK(declared_mime IN('image/jpeg','image/png','image/heic'));
