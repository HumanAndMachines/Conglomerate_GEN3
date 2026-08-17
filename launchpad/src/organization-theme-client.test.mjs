import { expect, test } from "bun:test";
import { safeOpaqueOrganizationThemeColor } from "../public/organization-theme.js";

test("Organization Theme přijme jen neprůhlednou platnou barvu", () => {
  for (const value of [
    "#6058e9",
    "#fff",
    "#ffff",
    "#ffffffff",
    "rgb(96 88 233)",
    "rgba(96, 88, 233, 1)",
    "hsl(244 76% 63% / 100%)",
  ]) {
    expect(safeOpaqueOrganizationThemeColor(value)).toBe(true);
  }

  for (const value of [
    "transparent",
    "#12345",
    "#fff0",
    "#ffffff80",
    "rgba(96, 88, 233, .5)",
    "rgb(96 88 233 / 20%)",
    "hsl(244 76% 63% / 50%)",
    "rgb(255,,255)",
    "not-a-color",
    "rgb()",
    "rgba(1,2,)",
  ]) {
    expect(safeOpaqueOrganizationThemeColor(value)).toBe(false);
  }
});
