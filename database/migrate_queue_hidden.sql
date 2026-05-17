-- Migration: Add is_hidden column to queue table for soft-delete
-- Run this against your smart_clinic database

USE smart_clinic;

-- Note: MySQL < 8.0.29 does not support "ADD COLUMN IF NOT EXISTS"
-- If the column already exists, this will error harmlessly.
ALTER TABLE queue ADD COLUMN is_hidden TINYINT(1) DEFAULT 0;
