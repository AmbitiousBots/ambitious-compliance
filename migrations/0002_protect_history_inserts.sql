CREATE TRIGGER history_no_reinsert BEFORE INSERT ON history
WHEN EXISTS (SELECT 1 FROM history WHERE seq = NEW.seq OR hash = NEW.hash)
BEGIN
  SELECT RAISE(ABORT, 'History cannot be replaced. Append a new change.');
END;
