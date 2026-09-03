import{readFile}from"node:fs/promises";
const marker=await readFile("marker.txt","utf8");if(marker.trim()!=="LCC_VERIFICATION_FIXTURE_OK")throw new Error("fixture marker mismatch");console.log("LCC_FIXED_VERIFICATION_OK");
