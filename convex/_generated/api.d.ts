/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agent from "../agent.js";
import type * as ai_colours from "../ai/colours.js";
import type * as ai_image_input from "../ai/image_input.js";
import type * as ai_openai from "../ai/openai.js";
import type * as ai_pipeline from "../ai/pipeline.js";
import type * as ai_prompts from "../ai/prompts.js";
import type * as avatars from "../avatars.js";
import type * as credits from "../credits.js";
import type * as demoWardrobe from "../demoWardrobe.js";
import type * as dev_smoke from "../dev/smoke.js";
import type * as http from "../http.js";
import type * as items from "../items.js";
import type * as jobs from "../jobs.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as model_admin from "../model/admin.js";
import type * as model_avatars from "../model/avatars.js";
import type * as model_credits from "../model/credits.js";
import type * as model_demo_wardrobe from "../model/demo_wardrobe.js";
import type * as model_items from "../model/items.js";
import type * as model_jobs from "../model/jobs.js";
import type * as model_outfits from "../model/outfits.js";
import type * as model_renders from "../model/renders.js";
import type * as model_stats from "../model/stats.js";
import type * as model_threads from "../model/threads.js";
import type * as model_uploads from "../model/uploads.js";
import type * as model_users from "../model/users.js";
import type * as outfits from "../outfits.js";
import type * as renders from "../renders.js";
import type * as shared_credits from "../shared/credits.js";
import type * as shared_demo_wardrobe from "../shared/demo_wardrobe.js";
import type * as shared_jobs from "../shared/jobs.js";
import type * as shared_validators from "../shared/validators.js";
import type * as shared_wardrobe from "../shared/wardrobe.js";
import type * as subscriptions from "../subscriptions.js";
import type * as threads from "../threads.js";
import type * as uploads from "../uploads.js";
import type * as users from "../users.js";
import type * as views from "../views.js";
import type * as workflows_ingest from "../workflows/ingest.js";
import type * as workflows_manager from "../workflows/manager.js";
import type * as workflows_render from "../workflows/render.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agent: typeof agent;
  "ai/colours": typeof ai_colours;
  "ai/image_input": typeof ai_image_input;
  "ai/openai": typeof ai_openai;
  "ai/pipeline": typeof ai_pipeline;
  "ai/prompts": typeof ai_prompts;
  avatars: typeof avatars;
  credits: typeof credits;
  demoWardrobe: typeof demoWardrobe;
  "dev/smoke": typeof dev_smoke;
  http: typeof http;
  items: typeof items;
  jobs: typeof jobs;
  "lib/auth": typeof lib_auth;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "model/admin": typeof model_admin;
  "model/avatars": typeof model_avatars;
  "model/credits": typeof model_credits;
  "model/demo_wardrobe": typeof model_demo_wardrobe;
  "model/items": typeof model_items;
  "model/jobs": typeof model_jobs;
  "model/outfits": typeof model_outfits;
  "model/renders": typeof model_renders;
  "model/stats": typeof model_stats;
  "model/threads": typeof model_threads;
  "model/uploads": typeof model_uploads;
  "model/users": typeof model_users;
  outfits: typeof outfits;
  renders: typeof renders;
  "shared/credits": typeof shared_credits;
  "shared/demo_wardrobe": typeof shared_demo_wardrobe;
  "shared/jobs": typeof shared_jobs;
  "shared/validators": typeof shared_validators;
  "shared/wardrobe": typeof shared_wardrobe;
  subscriptions: typeof subscriptions;
  threads: typeof threads;
  uploads: typeof uploads;
  users: typeof users;
  views: typeof views;
  "workflows/ingest": typeof workflows_ingest;
  "workflows/manager": typeof workflows_manager;
  "workflows/render": typeof workflows_render;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
