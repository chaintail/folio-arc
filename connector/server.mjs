const role=process.argv[2];if(!['as','mcp','core'].includes(role))throw Error('Usage: node server.mjs as|mcp|core');await import(`./${role}.mjs`);
