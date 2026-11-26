CREATE TABLE `assignment` (
	`id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assignment_course` ON `assignment` (`course_id`);--> statement-breakpoint
CREATE TABLE `criterion` (
	`id` integer PRIMARY KEY NOT NULL,
	`assignment_id` integer NOT NULL,
	`label` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `criterion_assignment` ON `criterion` (`assignment_id`,`position`);--> statement-breakpoint
CREATE TABLE `submission` (
	`id` integer PRIMARY KEY NOT NULL,
	`assignment_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`text` text NOT NULL,
	`file_hash` text,
	`file_name` text,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_assignment_student` ON `submission` (`assignment_id`,`roster_entry_id`);