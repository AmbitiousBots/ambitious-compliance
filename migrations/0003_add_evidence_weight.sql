ALTER TABLE evidence ADD COLUMN weight TEXT CHECK (weight IS NULL OR weight IN ('official', 'draft', 'decision'));
