// bun test preload (see each package's bunfig.toml): after every test file, close what the file
// registered with onTempCleanup() and remove the temp dirs it made with tempDir().

import { afterAll } from "bun:test";
import { cleanupTempDirs } from "./tmp";

afterAll(cleanupTempDirs);
