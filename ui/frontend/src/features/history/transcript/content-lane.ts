import { createContentWorkerClient } from "../../../content";
import { createTranscriptRenderLane } from "./render-lane";
/** Shared transcript lane prevents concurrent cards from flooding worker admission. */
export const transcriptContent = createTranscriptRenderLane(createContentWorkerClient());
