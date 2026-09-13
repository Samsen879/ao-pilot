import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// Resolve the workspace's expect, not a different hoisted Vitest major.
expect.extend(matchers);
