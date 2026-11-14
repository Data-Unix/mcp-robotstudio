"use strict";
// Pre-initialize OpenSSL DRBG while SystemRoot/windir are still present before esbuild-wasm strips process.env.
require("node:crypto").randomBytes(1);
