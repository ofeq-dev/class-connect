CREATE TABLE `help_match` (
	`help_request_id` integer PRIMARY KEY NOT NULL,
	`help_offer_id` integer NOT NULL,
	FOREIGN KEY (`help_request_id`) REFERENCES `help_request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`help_offer_id`) REFERENCES `help_offer`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `help_match_offer` ON `help_match` (`help_offer_id`);--> statement-breakpoint
CREATE TABLE `help_offer` (
	`id` integer PRIMARY KEY NOT NULL,
	`criterion_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`criterion_id`) REFERENCES `criterion`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_offer_criterion_student` ON `help_offer` (`criterion_id`,`roster_entry_id`);--> statement-breakpoint
CREATE TABLE `help_request` (
	`id` integer PRIMARY KEY NOT NULL,
	`criterion_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`level` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`criterion_id`) REFERENCES `criterion`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_request_criterion_student` ON `help_request` (`criterion_id`,`roster_entry_id`);--> statement-breakpoint
ALTER TABLE `assignment` ADD `released_at` integer;--> statement-breakpoint
ALTER TABLE `assignment` ADD `match_deadline` integer;--> statement-breakpoint
ALTER TABLE `assignment` ADD `matched_at` integer;