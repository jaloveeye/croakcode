ALTER TABLE `todo` ADD COLUMN `linked_tool_calls` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `todo` ADD COLUMN `evidence` text NOT NULL DEFAULT 'tool';
