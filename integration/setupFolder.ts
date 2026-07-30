/**
 * One-time setup: create the containment folder the integration suite files
 * every fixture into.
 *
 * Kept out of the suite proper on purpose. `push` cannot create folders, so
 * the suite is structurally unable to invent a container outside the one a
 * human sanctioned; this script is that sanction, run deliberately and once.
 * Creating the folder by hand in Apple Notes or at icloud.com works equally
 * well.
 *
 *   npx tsx integration/setupFolder.ts [folder-name]
 */

import { chromium } from "playwright";
import { DEFAULT_TEST_FOLDER } from "./config.js";
import { profileDirForDsid } from "./webOracle.js";

const folderName = process.argv[2] ?? DEFAULT_TEST_FOLDER;
const dsid = process.env.ICLOUD_MD_ITEST_DSID;
if (dsid === undefined || dsid === "") {
  console.error("Set ICLOUD_MD_ITEST_DSID to the account's dsid (see ~/.config/icloud-md/accounts/).");
  process.exit(2);
}

const context = await chromium.launchPersistentContext(profileDirForDsid(dsid), {
  headless: process.env.ICLOUD_MD_ITEST_HEADED !== "1",
  viewport: { width: 1440, height: 900 },
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.icloud.com/notes", { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + 60_000;
  let frame = page.frames().find((f) => f.url().includes("notes3"));
  while (!frame && Date.now() < deadline) {
    await page.waitForTimeout(250);
    frame = page.frames().find((f) => f.url().includes("notes3"));
  }
  if (!frame) {
    throw new Error("iCloud Notes app frame never appeared");
  }

  const folderList = frame.locator(".folder-list");
  await folderList.waitFor({ state: "visible", timeout: 60_000 });

  const existing = await frame.locator('.folder-list [role="treeitem"]').allTextContents();
  if (existing.some((name) => name.trim() === folderName)) {
    console.log(`Folder "${folderName}" already exists - nothing to do.`);
  } else {
    await frame.locator(".folder-add-button").click();
    await page.waitForTimeout(1_500);
    await page.keyboard.type(folderName);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(4_000);

    const after = await frame.locator('.folder-list [role="treeitem"]').allTextContents();
    if (!after.some((name) => name.trim() === folderName)) {
      throw new Error(`Folder "${folderName}" was not created. Sidebar now shows: ${after.map((n) => n.trim()).join(", ")}`);
    }
    console.log(`Created folder "${folderName}".`);
  }

  console.log(`Sidebar folders: ${(await frame.locator('.folder-list [role="treeitem"]').allTextContents()).map((n) => n.trim()).join(", ")}`);
} finally {
  await context.close().catch(() => undefined);
}
