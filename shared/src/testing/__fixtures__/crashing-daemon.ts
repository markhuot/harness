// A "daemon" that dies at once with a message: for testing early-exit detection.
console.error("boom: cannot bind");
process.exit(3);
