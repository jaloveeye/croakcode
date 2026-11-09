CREATE TABLE `permit_nonce` (
	`nonce` text PRIMARY KEY NOT NULL,
	`exp` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `permit_nonce_exp_idx` ON `permit_nonce` (`exp`);
