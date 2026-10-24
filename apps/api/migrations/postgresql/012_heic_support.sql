-- HEIC joins the existing private scan/decode/publication path; branding ancestry is unchanged.
ALTER TABLE longball.brand_assets DROP CONSTRAINT brand_assets_declared_mime_check;
ALTER TABLE longball.brand_assets ADD CONSTRAINT brand_assets_declared_mime_check CHECK(declared_mime IN('image/jpeg','image/png','image/heic')) NOT VALID;
DO $validate$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM longball.brand_assets WHERE declared_mime NOT IN('image/jpeg','image/png','image/heic')) THEN
  ALTER TABLE longball.brand_assets VALIDATE CONSTRAINT brand_assets_declared_mime_check;
 END IF;
END $validate$;
