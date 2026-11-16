CREATE INDEX package_cache_kept_name ON package_cache_entries(kind,ecosystem,substr(key,1,instr(substr(key,2),'@')),last_used_at) WHERE size>0;
--> statement-breakpoint
CREATE INDEX package_requirements_key ON package_project_requirements(key,project_id);
--> statement-breakpoint
CREATE INDEX package_cache_file_hash ON package_cache_entries(kind,sha256) WHERE size>0;
