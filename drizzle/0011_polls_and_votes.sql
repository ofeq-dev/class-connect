CREATE TABLE `poll` (
	`id` integer PRIMARY KEY NOT NULL,
	`topic_id` integer NOT NULL,
	`question` text NOT NULL,
	`scheduled_open_at` integer,
	`close_after_minutes` integer,
	`opened_at` integer,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topic`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `poll_topic` ON `poll` (`topic_id`);--> statement-breakpoint
CREATE TABLE `poll_option` (
	`id` integer PRIMARY KEY NOT NULL,
	`poll_id` integer NOT NULL,
	`label` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `poll`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `poll_option_poll` ON `poll_option` (`poll_id`,`position`);--> statement-breakpoint
CREATE TABLE `vote` (
	`id` integer PRIMARY KEY NOT NULL,
	`poll_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`option_id` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `poll`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_id`) REFERENCES `poll_option`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vote_one_per_entry` ON `vote` (`poll_id`,`roster_entry_id`);