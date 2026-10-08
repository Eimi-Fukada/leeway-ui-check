---
name: leeway-ui-check
description: Implement and iteratively repair UI against a reference screenshot using the Leeway five-tool MCP until verified or its iteration policy stops the task.
---

Use this workflow when the user requests Leeway UI reconstruction. Follow explicit user scope and cancellation.

1. Call `ui_check_start` with the reference image, viewport and target setup. Preserve the returned `run_id` and acceptance requirements.
2. Modify the target code, then call `ui_check_submit` with a new `request_id` for each changed version. Reuse the same request ID only to retry the same submission.
3. Use `task_status` and `next_action`, not legacy `status=completed`, to decide what happens next:
   - `evaluating`: poll `ui_check_status` with the same run/request IDs. Never queue duplicate work.
   - `needs_revision`: actually read the reference/actual/diff crop images, repair code, and resubmit within budget. Do not end by asking the user to say continue.
   - `ready_to_finalize`: call `ui_check_finalize`; only its successful passing task result is delivery.
   - `blocked`: inspect the reason. Configuration/calibration review requires human action; do not keep modifying UI when only `profile_not_validated` remains. Diagnose recoverable runtime errors before retrying.
   - terminal task: report pass, cancellation, failure, stalled progress or exhausted budget accurately.
4. Do not modify reference images, thresholds, masks or profiles to obtain a pass. A high score without gate approval is not success.
5. Image URI presence does not mean you have seen the image. If the host cannot read the MCP resources, explain the evidence-access limitation.

The MCP worker runs automatically. CLI and MCP share the same five operations. The optional Codex Stop hook requests continuation only for a task bound to the current chat, with its own cap; user interruption disables that binding.
