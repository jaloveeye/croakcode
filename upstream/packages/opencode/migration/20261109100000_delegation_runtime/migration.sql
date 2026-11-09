CREATE TABLE `agent_principals` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`definition` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`capabilities` text NOT NULL,
	`created_by` text NOT NULL,
	`revoked_reason` text,
	`time_revoked` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `agent_principals_owner_idx` ON `agent_principals` (`owner_id`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY,
	`principal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_run_id` text,
	`grant_id` text,
	`policy_revision` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`time_ended` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `agent_runs_principal_idx` ON `agent_runs` (`principal_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_session_idx` ON `agent_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_parent_idx` ON `agent_runs` (`parent_run_id`);--> statement-breakpoint
CREATE TABLE `delegation_grants` (
	`id` text PRIMARY KEY,
	`delegator_principal_id` text NOT NULL,
	`delegatee_principal_id` text NOT NULL,
	`parent_grant_id` text,
	`parent_run_id` text NOT NULL,
	`capabilities` text NOT NULL,
	`scope` text NOT NULL,
	`constraints` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`depth` integer NOT NULL,
	`policy_revision` integer NOT NULL,
	`revoked_reason` text,
	`time_revoked` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `delegation_grants_delegatee_idx` ON `delegation_grants` (`delegatee_principal_id`);--> statement-breakpoint
CREATE INDEX `delegation_grants_parent_idx` ON `delegation_grants` (`parent_grant_id`);--> statement-breakpoint
CREATE INDEX `delegation_grants_parent_run_idx` ON `delegation_grants` (`parent_run_id`);--> statement-breakpoint
CREATE TABLE `execution_audit` (
	`audit_id` integer PRIMARY KEY AUTOINCREMENT,
	`event_type` text NOT NULL,
	`principal_id` text,
	`run_id` text,
	`parent_run_id` text,
	`session_id` text,
	`grant_id` text,
	`tool` text,
	`decision` text,
	`error_code` text,
	`policy_revision` integer,
	`time_created` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `execution_audit_principal_idx` ON `execution_audit` (`principal_id`);--> statement-breakpoint
CREATE INDEX `execution_audit_run_idx` ON `execution_audit` (`run_id`);--> statement-breakpoint
CREATE INDEX `execution_audit_parent_run_idx` ON `execution_audit` (`parent_run_id`);
