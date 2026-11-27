CREATE TABLE `roster_entry` (
	`id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`student_id` text NOT NULL,
	`name` text NOT NULL,
	`device_token_hash` text,
	`claimed_at` integer,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roster_entry_course_student` ON `roster_entry` (`course_id`,`student_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`date` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`qr_code` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_qr_code` ON `session` (`qr_code`);--> statement-breakpoint
CREATE INDEX `session_course_date` ON `session` (`course_id`,`date`);