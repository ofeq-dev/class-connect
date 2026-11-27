CREATE TABLE `class_summary` (
	`assignment_id` integer PRIMARY KEY NOT NULL,
	`counts` text NOT NULL,
	`common_mistakes` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review` (
	`id` integer PRIMARY KEY NOT NULL,
	`submission_id` integer NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`released_at` integer,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_submission_id_unique` ON `review` (`submission_id`);--> statement-breakpoint
CREATE TABLE `review_job` (
	`id` integer PRIMARY KEY NOT NULL,
	`run_id` integer NOT NULL,
	`submission_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `review_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_job_run` ON `review_job` (`run_id`);--> statement-breakpoint
CREATE INDEX `review_job_submission` ON `review_job` (`submission_id`);--> statement-breakpoint
CREATE TABLE `review_level` (
	`review_id` integer NOT NULL,
	`criterion_id` integer NOT NULL,
	`level` text NOT NULL,
	`evidence` text NOT NULL,
	`feedback` text NOT NULL,
	PRIMARY KEY(`review_id`, `criterion_id`),
	FOREIGN KEY (`review_id`) REFERENCES `review`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`criterion_id`) REFERENCES `criterion`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review_run` (
	`id` integer PRIMARY KEY NOT NULL,
	`assignment_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`compare_job_id` integer,
	`class_summary_job_id` integer,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_run_assignment` ON `review_run` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `similarity_pair` (
	`id` integer PRIMARY KEY NOT NULL,
	`assignment_id` integer NOT NULL,
	`submission_a_id` integer NOT NULL,
	`submission_b_id` integer NOT NULL,
	`score` real NOT NULL,
	`fingerprint_overlap` real NOT NULL,
	`embedding_similarity` real,
	`passages` text NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_a_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_b_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `similarity_pair_assignment` ON `similarity_pair` (`assignment_id`);