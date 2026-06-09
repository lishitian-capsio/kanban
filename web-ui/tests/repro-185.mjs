import { chromium } from "@playwright/test";

const errors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("pageerror", (err) => {
	errors.push(`PAGEERROR: ${err.message}`);
});
page.on("console", (msg) => {
	if (msg.type() === "error") {
		errors.push(`CONSOLE.ERROR: ${msg.text()}`);
	}
});

async function createTask(title) {
	const backlog = page.locator('[data-column-id="backlog"]').first();
	await backlog.getByRole("button", { name: "Create task" }).click();
	const prompt = page.getByPlaceholder("Describe the task");
	await prompt.fill(title);
	await prompt.press("Control+Enter");
	await page.waitForTimeout(200);
}

await page.goto("http://127.0.0.1:4173/");
await page.waitForTimeout(500);
console.log("LOAD ERRORS:", errors.length);

await createTask("dep-a");
await createTask("dep-b");
await page.waitForTimeout(300);

const cardA = page.locator('[data-task-id]').filter({ hasText: "dep-a" }).first();
const cardB = page.locator('[data-task-id]').filter({ hasText: "dep-b" }).first();
const a = await cardA.boundingBox();
const b = await cardB.boundingBox();

// ctrl-drag from A to B to create a dependency link
await page.keyboard.down("Control");
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
await page.mouse.up();
await page.keyboard.up("Control");
await page.waitForTimeout(800);

console.log("AFTER LINK ERRORS:", errors.length);
console.log("DEP PATHS:", await page.locator(".kb-dependency-path").count());

// reload to test "on load" with a dependency present (if persisted)
await page.reload();
await page.waitForTimeout(800);

console.log("=== ALL CAPTURED ERRORS ===");
for (const e of errors.slice(0, 20)) console.log(e);

await browser.close();
