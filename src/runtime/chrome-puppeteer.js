import puppeteer from "puppeteer-core";

function chromePath(config) {
  if (config.executablePath) return config.executablePath;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "";
}

export async function createPuppeteerChrome(config = {}) {
  const executablePath = chromePath(config);
  if (!executablePath) {
    throw new Error("set /etc/browser.json executablePath or CHROME_PATH");
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: config.headless ?? false,
    userDataDir: config.userDataDir || "./tmp/chrome"
  });

  async function allPages() {
    let pages = await browser.pages();
    if (pages.length === 0) pages = [await browser.newPage()];
    return pages;
  }

  async function pageByTabId(tabId) {
    const pages = await allPages();
    return pages[Math.max(0, Number(tabId || 1) - 1)] || pages[0];
  }

  return {
    tabs: {
      async query() {
        const pages = await allPages();
        return Promise.all(pages.map(async (page, index) => ({
          id: index + 1,
          active: index === pages.length - 1,
          currentWindow: true,
          url: page.url(),
          title: await page.title()
        })));
      }
    },
    scripting: {
      async executeScript(details) {
        const page = await pageByTabId(details?.target?.tabId);
        const args = details.args || [];
        const source = String(details.func);
        const result = await page.evaluate(
          async (source, values) => {
            const argv = values || [];
            const args = argv;
            const runtime = { argv, args };
            const log = (...items) => console.log(...items);
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const done = (value = "") => {
              throw { __dietsurfDone: true, value };
            };
            const unavailable = (name) => async () => {
              throw new Error(`${name} is not available inside chrome.scripting.executeScript`);
            };
            const shell = unavailable("shell");
            const llm = unavailable("llm");
            const node = unavailable("node");
            const readFile = unavailable("readFile");
            const writeFile = unavailable("writeFile");
            const listFiles = unavailable("listFiles");
            const bindings = { argv, args, runtime, log, sleep, done, shell, llm, node, readFile, writeFile, listFiles };
            const prior = {};
            for (const [key, value] of Object.entries(bindings)) {
              prior[key] = { exists: key in globalThis, value: globalThis[key] };
              globalThis[key] = value;
            }
            try {
              return await (0, eval)(`(${source})`)(...argv);
            } catch (error) {
              if (error && error.__dietsurfDone) return error.value;
              throw error;
            } finally {
              for (const [key, state] of Object.entries(prior)) {
                if (state.exists) globalThis[key] = state.value;
                else delete globalThis[key];
              }
            }
          },
          source,
          args
        );
        return [{ result }];
      }
    },
    close: () => browser.close()
  };
}
