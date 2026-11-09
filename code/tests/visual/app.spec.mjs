import { expect, test } from "@playwright/test";

const errors = [];

const map = (page) => page.locator(".ax-feature-map");

// Objects are pixels on a canvas, so tests ask the map what it has drawn.
const drawnIds = (page) =>
  map(page).evaluate((host) => [...host.wayfinder.drawn.keys()]);

async function settled(page) {
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() =>
      map(page).evaluate((host) => {
        const { map: m } = host.wayfinder;
        return m.isStyleLoaded() && m.areTilesLoaded() && !m.isMoving();
      }),
    )
    .toBe(true);
  await page.waitForTimeout(350);
}

async function objectsDrawn(page) {
  await expect.poll(async () => (await drawnIds(page)).length).toBeGreaterThan(0);
}

async function openCountry(page, id) {
  await objectsDrawn(page);
  await page.getByLabel("Country").selectOption(id);
  await expect(page.getByLabel("Country")).toHaveValue(id);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  await objectsDrawn(page);
  await settled(page);
}

// Where an object is on screen, using a point part-way along its shape.
async function objectPixel(page, id) {
  return map(page).evaluate((host, target) => {
    const { map: m } = host.wayfinder;
    const feature = m
      .getSource("matches")
      .serialize()
      .data.features.find(({ properties }) => properties.osm === target);
    const points = feature.geometry.coordinates;
    const point =
      typeof points[0] === "number"
        ? points
        : points[Math.floor((points.length - 1) / 2)].flat(9).slice(0, 2);
    const next =
      typeof points[0] === "number" || points.length < 2
        ? point
        : points[Math.floor((points.length - 1) / 2) + 1].flat(9).slice(0, 2);
    const { x, y } = m.project([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]);
    return { x, y };
  }, id);
}

async function clickObject(page, id) {
  await objectsDrawn(page);
  await settled(page);
  const { x, y } = await objectPixel(page, id);
  await map(page).click({ position: { x, y } });
}

const layerVisibility = (page, layer) =>
  map(page).evaluate(
    (host, name) => host.wayfinder.map.getLayoutProperty(name, "visibility") ?? "visible",
    layer,
  );

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // Keep the run hermetic: no fonts, tiles or anything else from the internet.
  await page.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort(),
  );
  await page.goto("/");
  await openCountry(page, "LU");
  await selectAllValues(page);
  await objectsDrawn(page);
  // The toolbar's last button arrives with the results and changes its height.
  await expect(page.locator(".ax-fit-matches")).toBeAttached();
  await settled(page);
});

async function selectAllValues(page) {
  await page.getByRole("button", { name: /^Tag value:/ }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("button", { name: /^Tag value: All values/ }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(350);
}

const external = /ERR_FAILED/;
const realErrors = () => errors.filter((text) => !external.test(text));

test("map view", async ({ page }) => {
  await expect(page).toHaveScreenshot("map.png", { fullPage: true });
  expect(realErrors()).toEqual([]);
});

test("the freshness view never scrolls sideways", async ({ page }) => {
  await page.getByRole("button", { name: /freshness/i }).click();
  await expect(page.locator(".ax-freshness-stats")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the page never scrolls sideways", async ({ page }) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("first load frames the whole country", async ({ page }) => {
  const box = await map(page).boundingBox();
  const { areas } = await (await page.request.get("/api/analytics/LU")).json();
  const [west, south, east, north] = areas[0].bounds;
  const spread = await map(page).evaluate(
    (host, [w, s, e, n]) => {
      const { map: m } = host.wayfinder;
      const low = m.project([w, s]);
      const high = m.project([e, n]);
      return {
        width: high.x - low.x,
        height: low.y - high.y,
        inside:
          m.getBounds().contains([w, s]) && m.getBounds().contains([e, n]),
      };
    },
    [west, south, east, north],
  );
  expect(spread.inside).toBe(true);
  expect(
    Math.max(spread.width / box.width, spread.height / box.height),
  ).toBeGreaterThan(0.5);
});

test.describe("desktop interactions @desktop", () => {
  test("right-click menu fits its text and stays inside the map", async ({
    page,
  }) => {
    const box = await map(page).boundingBox();
    for (const x of [box.width / 2, box.width - 8]) {
      await map(page).click({
        button: "right",
        position: { x, y: box.height / 2 },
      });
      const menu = page.locator(".ax-map-context-menu");
      await expect(menu).toBeVisible();
      // A nowrap button in a too-narrow menu widens itself, so measure against
      // the menu's inner edge as well as the button's own padding.
      const fits = await menu.evaluate((element) => {
        const style = getComputedStyle(element);
        const inner =
          element.getBoundingClientRect().right -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderRightWidth);
        return [...element.querySelectorAll("button")].every((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const box = button.getBoundingClientRect();
          return (
            box.right <= inner + 1 &&
            range.getBoundingClientRect().right <=
              box.right - parseFloat(getComputedStyle(button).paddingRight) + 1
          );
        });
      });
      expect(fits).toBe(true);
      const area = await menu.boundingBox();
      expect(area.x + area.width).toBeLessThanOrEqual(box.x + box.width);
    }
    await expect(page).toHaveScreenshot("context-menu.png");
  });

  test("table view lists tag values", async ({ page }) => {
    await page.getByRole("button", { name: /table view/i }).click();
    await expect(
      page.locator(".ax-tag-table-content").getByRole("cell", { name: "motorway" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("table.png", { fullPage: true });
  });

  test("table and distribution panels line up", async ({ page }) => {
    await page.getByRole("button", { name: /table view/i }).click();
    await expect(
      page.locator(".ax-tag-table-content").getByRole("cell", { name: "motorway" }),
    ).toBeVisible();
    const content = await page.locator(".ax-tag-table-content").boundingBox();
    const visual = await page
      .locator(".ax-tag-table-layout .ax-tag-visual")
      .boundingBox();
    expect(Math.abs(content.height - visual.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(content.y - visual.y)).toBeLessThanOrEqual(1);
    const sort = await page.locator(".ax-tag-filters select").boundingBox();
    const exported = await page
      .getByRole("button", { name: /export csv/i })
      .or(page.getByRole("link", { name: /export csv/i }))
      .boundingBox();
    expect(Math.abs(sort.y - exported.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(sort.height - exported.height)).toBeLessThanOrEqual(1);
    const heading = await page
      .getByRole("heading", { name: "Exact tag values" })
      .boundingBox();
    const firstCell = await page
      .locator(".ax-tag-table-content tbody td:first-child, .ax-tag-table-content tbody th:first-child")
      .first()
      .evaluate((cell) => {
        const box = cell.getBoundingClientRect();
        return box.left + parseFloat(getComputedStyle(cell).paddingLeft);
      });
    expect(Math.abs(firstCell - heading.x)).toBeLessThanOrEqual(1);
  });

  test("table view breaks the key down by region", async ({ page }) => {
    await page.getByRole("button", { name: /table view/i }).click();
    const section = page.locator(".ax-tag-regions");
    await expect(section).toContainText("By canton");
    const first = section.locator("tbody tr").first();
    await expect(first).toContainText("Canton 01");
    await expect(first).toContainText("service");
    await section.getByRole("button", { name: "Canton 02" }).click();
    await expect(
      page.getByRole("combobox", { name: /canton/i }),
    ).toHaveValue("C02");
    await expect(section.locator("tr.is-selected")).toContainText("Canton 02");
    // The comparison still lists every canton after focusing on one.
    await expect(section.locator("tbody tr")).toHaveCount(12);
  });

  test("freshness view summarises the current filters", async ({ page }) => {
    await page.getByRole("button", { name: /freshness/i }).click();
    const stats = page.locator(".ax-freshness-stats");
    await expect(stats).toContainText("Objects");
    await expect(stats.getByText("7", { exact: true })).toBeVisible();
    await expect(stats).toContainText("Feb 2024");
    await expect(page.getByRole("link", { name: /A1/ }).first()).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/way/201/history",
    );
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("freshness.png", { fullPage: true });
    expect(realErrors()).toEqual([]);
  });

  test("freshness rows focus an area and filters still apply", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /freshness/i }).click();
    await page.getByRole("button", { name: "Canton 02" }).click();
    await expect(page.getByRole("combobox", { name: /canton/i })).toHaveValue(
      "C02",
    );
    await expect(
      page.locator(".ax-freshness-stats > div:first-child dd"),
    ).toHaveText("1");
    await expect(page.getByRole("heading", { name: /Canton 02/ })).toBeVisible();
  });

  test("the inspector shows the last edit and version", async ({ page }) => {
    await clickObject(page, "way/201");
    await expect(page.getByText("1 Mar 2019 · version 40")).toBeVisible();
  });

  test("each country opens on its most common road type", async ({ page }) => {
    await openCountry(page, "XX");
    await expect(page.getByText("highway=primary")).toBeVisible();
    await openCountry(page, "LU");
    await expect(page.getByText("highway=service")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Tag value: service, 2 objects/ }),
    ).toBeVisible();
  });

  test("a newly chosen key starts on its first value", async ({ page }) => {
    await page.getByRole("button", { name: /^Tag key:/ }).click();
    await page.getByRole("checkbox", { name: /^amenity/ }).click();
    await expect(page.getByText("amenity=cafe")).toBeVisible();
  });

  test("select all values and select all keys", async ({ page }) => {
    await expect(page.getByText("highway=*")).toBeVisible();
    await page.getByRole("button", { name: /^Tag key:/ }).click();
    await page.getByRole("button", { name: "Select all" }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(
      page.getByRole("button", { name: "Tag key: All keys, 17 objects" }),
    ).toBeVisible();
    await expect(page.locator(".ax-rule-chip", { hasText: "All keys" })).toBeVisible();
    await expect.poll(() => drawnIds(page)).toContain("way/204");
    await expect(page.getByRole("button", { name: /^Tag value:/ })).toBeDisabled();

    await page.getByRole("button", { name: /^Tag key:/ }).click();
    await page.getByRole("checkbox", { name: /^building/ }).click();
    await expect(page.getByRole("button", { name: /^Tag key: building/ })).toBeVisible();
    await expect(page.getByText("building=yes")).toBeVisible();
  });

  test("the map zooms out to the lowest level with tiles", async ({ page }) => {
    await page.route("**/imagery/**", (route) => route.abort());
    const minZoom = () =>
      map(page).evaluate((host) => host.wayfinder.map.getMinZoom());
    expect(await minZoom()).toBe(4);
    await page.getByRole("button", { name: "Satellite" }).click();
    await expect.poll(minZoom).toBe(6);
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect.poll(minZoom).toBe(4);
  });

  test("short roads in a dense view still show as dots", async ({ page }) => {
    // More than the 120 objects that used to be needed before dots appeared.
    await page.route("**/api/analytics/LU/features*", (route) =>
      route.fulfill({
        json: {
          type: "FeatureCollection",
          limited: true,
          features: Array.from({ length: 200 }, (_, index) => ({
            type: "Feature",
            id: "way/" + (9000 + index),
            properties: {
              kind: "way",
              id: 9000 + index,
              label: null,
              tags: [["highway", "residential"]],
              value: "residential",
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [5.92 + index * 0.0015, 49.55],
                [5.92 + index * 0.0015 + 0.00001, 49.55],
              ],
            },
          })),
        },
      }),
    );
    await page.getByRole("button", { name: /^Tag value:/ }).click();
    await page.getByRole("checkbox", { name: /^motorway/ }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect
      .poll(() =>
        map(page).evaluate(
          (host) =>
            host.wayfinder.map
              .querySourceFeatures("matches")
              .filter((feature) => feature.geometry.type === "Point").length,
        ),
      )
      .toBeGreaterThan(100);
  });

  test.describe("filters", () => {
    const keyTrigger = (page) =>
      page.getByRole("button", { name: /^Tag key:/ });
    const valueTrigger = (page) =>
      page.getByRole("button", { name: /^Tag value:/ });
    const label = (locator) => locator.getAttribute("aria-label");
    const expectValue = (page, text) =>
      expect(valueTrigger(page)).toHaveAttribute("aria-label", text);
    const expectKey = (page, text) =>
      expect(keyTrigger(page)).toHaveAttribute("aria-label", text);
    const tick = (page, name) =>
      page.getByRole("checkbox", { name: new RegExp("^" + name) }).click();
    const done = (page) => page.getByRole("button", { name: "Done" }).click();
    const choose = async (page, ...values) => {
      await valueTrigger(page).click();
      for (const value of values) await tick(page, value);
      await done(page);
    };

    test("one click narrows all values to that value", async ({ page }) => {
      await choose(page, "motorway");
      await expectValue(page, "Tag value: motorway, 1 objects");
    });

    test("several values can be added and removed", async ({ page }) => {
      await choose(page, "motorway", "service");
      await expectValue(page, "Tag value: 2 values, 3 objects");
      await choose(page, "service");
      await expectValue(page, "Tag value: motorway, 1 objects");
    });

    test("clicking the only selected value keeps it selected", async ({
      page,
    }) => {
      await choose(page, "motorway");
      await valueTrigger(page).click();
      await tick(page, "motorway");
      await expect(
        page.getByRole("button", { name: "Remove motorway" }),
      ).toBeDisabled();
      await done(page);
      await page.waitForTimeout(400);
      await expectValue(page, "Tag value: motorway, 1 objects");
    });

    test("the same rule holds in the table", async ({ page }) => {
      await choose(page, "motorway");
      await page.getByRole("button", { name: /table view/i }).click();
      await page
        .locator(".ax-tag-table-content")
        .getByRole("button", { name: "motorway" })
        .click();
      await page.waitForTimeout(400);
      await expectValue(page, "Tag value: motorway, 1 objects");
    });

    test("select all is the way back to every value", async ({ page }) => {
      await choose(page, "motorway");
      await selectAllValues(page);
      await expectValue(page, "Tag value: All values, 7 objects");
    });

    test("a value missing from a canton falls back to its first", async ({
      page,
    }) => {
      await choose(page, "bus_stop");
      await page.getByRole("combobox", { name: /canton/i }).selectOption("C02");
      await expectValue(page, "Tag value: motorway, 1 objects");
    });

    test("a value missing for an object type falls back too", async ({
      page,
    }) => {
      await choose(page, "motorway");
      await page.getByLabel("Object type").selectOption("node");
      await expect(valueTrigger(page)).toHaveAttribute(
        "aria-label",
        /^Tag value: (bus_stop|traffic_signals), 1 objects$/,
      );
    });

    test("all values survive a canton change", async ({ page }) => {
      await page.getByRole("combobox", { name: /canton/i }).selectOption("C02");
      await expectValue(page, "Tag value: All values, 1 objects");
    });

    test("keys can be added, matched together and removed", async ({
      page,
    }) => {
      await keyTrigger(page).click();
      await tick(page, "barrier");
      await page.getByRole("button", { name: "barrier" }).first().waitFor();
      await done(page);
      await expect
        .poll(() => label(keyTrigger(page)))
        .toMatch(/^Tag key: highway \+1,/);
      await page.getByLabel("Key matching").selectOption({ index: 1 });
      await expect
        .poll(() => label(valueTrigger(page)))
        .toMatch(/, 0 objects$/);
      await keyTrigger(page).click();
      await tick(page, "barrier");
      await done(page);
      await expect
        .poll(() => label(keyTrigger(page)))
        .toBe("Tag key: highway, 7 objects");
    });

    test("removing the last key leaves nothing selected", async ({ page }) => {
      await keyTrigger(page).click();
      await tick(page, "highway");
      await done(page);
      await expectKey(page, "Tag key: Choose tag keys");
      await expect(valueTrigger(page)).toBeDisabled();
      await expect
        .poll(() => map(page).evaluate((host) => host.wayfinder.drawn.size))
        .toBe(0);
    });

    test("clear removes every key, including all keys", async ({ page }) => {
      await keyTrigger(page).click();
      await page.getByRole("button", { name: "Select all" }).click();
      await page.getByRole("button", { name: "Clear" }).click();
      await done(page);
      await expectKey(page, "Tag key: Choose tag keys");
    });
  });

  test("objects can be hidden to see only the base map", async ({ page }) => {
    await page.route("**/imagery/**", (route) => route.abort());
    const labels = page.locator(".ax-map-place").first();
    await expect(labels).toBeVisible();
    expect(await layerVisibility(page, "matches-point")).toBe("visible");

    await page.getByRole("button", { name: "Hide objects" }).click();
    await expect.poll(() => layerVisibility(page, "matches-point")).toBe("none");
    // On the street map, place names belong to the base map and stay.
    await expect(labels).toBeVisible();

    await page.getByRole("button", { name: "Satellite" }).click();
    await expect(labels).toBeHidden();
    expect(await layerVisibility(page, "matches-point")).toBe("none");

    await page.getByRole("button", { name: "Show objects" }).click();
    await expect.poll(() => layerVisibility(page, "matches-point")).toBe("visible");
    await expect(labels).toBeVisible();
  });

  test("satellite replaces the drawn base map with imagery", async ({ page }) => {
    await page.route("**/imagery/**", (route) => route.abort());
    expect(await layerVisibility(page, "imagery")).toBe("none");
    await page.getByRole("button", { name: "Satellite" }).click();
    await expect.poll(() => layerVisibility(page, "imagery")).toBe("visible");
    expect(await layerVisibility(page, "regions-fill")).toBe("none");
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect.poll(() => layerVisibility(page, "imagery")).toBe("none");
    expect(await layerVisibility(page, "regions-fill")).toBe("visible");
  });

  test("changing country while on satellite keeps the page open", async ({
    page,
  }) => {
    await page.route("**/imagery/**", (route) => route.abort());
    await page.getByRole("button", { name: "Satellite" }).click();
    await page.getByLabel("Country").selectOption("XX");
    await expect(page.getByLabel("Country")).toHaveValue("XX");
    await page.waitForLoadState("networkidle");
    await expect(map(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Satellite" })).toBeHidden();
    expect(realErrors()).toEqual([]);
  });

  test("objects and chips switch to imagery colours", async ({ page }) => {
    await page.route("**/imagery/**", (route) => route.abort());
    const lineColour = () =>
      map(page).evaluate((host) =>
        JSON.stringify(host.wayfinder.map.getPaintProperty("matches-line", "line-color")),
      );
    const chip = page.locator(".ax-rule-chip i").first();
    await expect.poll(lineColour).toContain("street");
    await expect(chip).toHaveCSS("background-color", "rgb(255, 171, 104)");

    await page.getByRole("button", { name: "Satellite" }).click();
    await expect.poll(lineColour).toContain("aerial");
    await expect(chip).toHaveCSS("background-color", "rgb(25, 227, 255)");

    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect.poll(lineColour).toContain("street");
    await expect(chip).toHaveCSS("background-color", "rgb(255, 171, 104)");
  });

  test("hiding objects closes the open details panel", async ({ page }) => {
    await clickObject(page, "way/201");
    await expect(page.locator(".ax-object-inspector")).toBeVisible();
    await page.getByRole("button", { name: "Hide objects" }).click();
    await expect(page.locator(".ax-object-inspector")).toBeHidden();
  });

  test("selecting a feature opens its details", async ({ page }) => {
    await clickObject(page, "way/201");
    await expect(page.getByText("ref", { exact: true })).toBeVisible();
    await expect(page.getByText("A1").first()).toBeVisible();
    await settled(page);
    await expect(page).toHaveScreenshot("inspector.png");
  });

  test("changing the object type updates the map", async ({ page }) => {
    await page.getByLabel("Object type").selectOption("node");
    await expect(
      page.getByRole("button", { name: "Tag key: highway, 2 objects" }),
    ).toBeVisible();
  });

  test("choosing a canton limits the results", async ({ page }) => {
    await page.getByLabel("Canton").selectOption("C02");
    await expect(
      page.getByRole("button", { name: "Tag key: highway, 1 objects" }),
    ).toBeVisible();
  });

  test("a country across 180 degrees opens framed and draws both sides", async ({
    page,
  }) => {
    await openCountry(page, "XX");
    await expect.poll(() => drawnIds(page)).toEqual(
      expect.arrayContaining(["way/2001", "way/2002"]),
    );
    const box = await map(page).boundingBox();
    for (const id of ["way/2001", "way/2002"]) {
      const { x } = await objectPixel(page, id);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(box.width);
    }
    await expect(page).toHaveScreenshot("dateline.png");
    expect(realErrors()).toEqual([]);
  });

  test("nearby query from the map lists results", async ({ page }) => {
    await map(page).click({ button: "right", position: { x: 300, y: 300 } });
    await page.getByRole("button", { name: /query nearby/i }).click();
    await expect(page.getByText(/nearby|radius/i).first()).toBeVisible();
    await settled(page);
    await expect(page).toHaveScreenshot("nearby.png");
  });
});
