import { sql, type Expression, type RawBuilder } from "kysely";
import { jsonPickObject } from "../../infra/database-engine/json-values.js";
import type { PostgresSqlConnection } from "../../infra/sql-connection.js";
import { MODEL_CONTEXT_NAVIGATION_KEYS } from "./session-model-context-navigation.js";
import {
  projectModelContextBytesSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
} from "./session-model-context-projection.js";
import { MAX_COMPRESSED_EVENT_BYTES, MAX_NAVIGATION_BYTES } from "./transcript-payload-read.js";

/** The INSERT owns this derived envelope; canonical JSON remains unchanged. */
export function projectPostgresTranscriptPayloadSql(
  database: PostgresSqlConnection,
  eventJson: Expression<string | null>,
  reportJson: Expression<string | null>,
): RawBuilder<string | null> {
  const event =
    /* kysely-allow-raw: Fixed column from the guarded payload_source CTE below. */ sql.ref<string>(
      "payload_source.event",
    );
  const report =
    /* kysely-allow-raw: Fixed column from the bound payload_source CTE below. */ sql.ref<string>(
      "payload_source.report_json",
    );
  const message = /* kysely-allow-raw: Fixed member of the validated JSONB payload. */ sql<string>`(${event} -> 'message')`;
  const internal = jsonPickObject(database, sql`(${message} -> '__openclaw')`, [
    "runId",
    "steerTargetRunId",
    "contextFreeCommand",
  ]);
  const messageNavigation = jsonPickObject(database, message, [
    "role",
    "idempotencyKey",
    "provenance",
    "excludeFromContext",
    "__openclaw",
  ]);
  const navigation = jsonPickObject(database, event, MODEL_CONTEXT_NAVIGATION_KEYS);
  // Only replace members that exist: missing, explicit null and empty objects are distinct.
  const projectedMessage = sql`CASE WHEN jsonb_typeof(${message} -> '__openclaw') = 'object'
    THEN ${messageNavigation}::jsonb || jsonb_build_object('__openclaw', ${internal}::jsonb)
    ELSE ${messageNavigation}::jsonb END`;
  const projectedNavigation = sql`CASE WHEN jsonb_exists(${event}, 'message')
    THEN ${navigation}::jsonb || jsonb_build_object('message',
      CASE WHEN jsonb_typeof(${message}) = 'object' THEN ${projectedMessage} ELSE ${message} END)
    ELSE ${navigation}::jsonb END`;
  // Materialization keeps invalid text out of JSONB casts and reuses the parsed payload.
  // The same model builders serve the legacy read fallback, preserving JSONB byte accounting.
  return /* kysely-allow-raw: one parameterized INSERT expression derives bounded metadata from its own payload. */ sql<
    string | null
  >`(WITH payload_input AS MATERIALIZED (
      SELECT ${eventJson}::text AS event_json, ${reportJson}::text AS report_json
    ), payload_source AS MATERIALIZED (
      SELECT CASE WHEN pg_input_is_valid(event_json, 'jsonb')
        THEN event_json::jsonb ELSE NULL END AS event, report_json FROM payload_input
    ), payload_metadata AS MATERIALIZED (
      SELECT CASE WHEN jsonb_typeof(${event}) = 'object'
        AND coalesce(jsonb_typeof(${message}), 'null') IN ('object', 'null')
        AND ${report} IS NOT NULL
      THEN jsonb_build_object(
        'version', 1,
        'report', ${report}::jsonb,
        'navigation', ${projectedNavigation},
        'reset', ${projectResetBoundaryNavigationSql(database, event, sql`true`)}::jsonb,
        'model', ${projectModelContextNavigationSql(database, event)}::jsonb,
        'modelBytes', ${projectModelContextBytesSql(database, event, sql.lit(0))},
        'modelWithoutCheckpointBytes', ${projectModelContextBytesSql(database, event, sql.lit(1))},
        'withoutCustomDataBytes', octet_length((${event} - 'data')::text)
      )::text ELSE NULL END AS navigation_json FROM payload_source
    ) SELECT CASE WHEN octet_length(navigation_json) <= ${MAX_NAVIGATION_BYTES}
      AND (navigation_json::jsonb ->> 'modelBytes')::bigint <= ${MAX_COMPRESSED_EVENT_BYTES}
      AND (navigation_json::jsonb ->> 'modelWithoutCheckpointBytes')::bigint <= ${MAX_COMPRESSED_EVENT_BYTES}
      AND (navigation_json::jsonb ->> 'withoutCustomDataBytes')::bigint <= ${MAX_COMPRESSED_EVENT_BYTES}
      THEN navigation_json ELSE NULL END
      FROM payload_metadata)`;
}
