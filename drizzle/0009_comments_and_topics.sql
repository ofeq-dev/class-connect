CREATE TABLE `comment` (
	`id` integer PRIMARY KEY NOT NULL,
	`topic_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`text` text NOT NULL,
	`anonymous` integer NOT NULL,
	`timing` text,
	`status` text NOT NULL,
	`reaction` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topic`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comment_topic` ON `comment` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `topic` (
	`id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`kind` text NOT NULL,
	`session_id` integer,
	`name` text,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `topic_course` ON `topic` (`course_id`);