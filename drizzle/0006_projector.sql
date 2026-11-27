ALTER TABLE `course` ADD `projector_secret` text;--> statement-breakpoint
-- Existing Courses get a link too; new ones get one when created.
UPDATE `course` SET `projector_secret` = lower(hex(randomblob(16))) WHERE `projector_secret` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `course_projector_secret` ON `course` (`projector_secret`);--> statement-breakpoint
ALTER TABLE `session` ADD `projector_mode` text;--> statement-breakpoint
ALTER TABLE `session` ADD `projected_poll_id` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `projector_set_at` integer;