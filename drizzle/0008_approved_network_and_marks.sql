CREATE TABLE `approved_network` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`block` text NOT NULL,
	`approved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approved_network_session_block` ON `approved_network` (`session_id`,`block`);--> statement-breakpoint
ALTER TABLE `attendance` ADD `check_in_state` text;