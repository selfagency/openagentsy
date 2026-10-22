import { describe, expect, it } from "vitest"
import { globToRegExp, matchesGlob, normalizePath, relativeToRoot } from "./paths.js"

describe("globToRegExp", () => {
  it("lets a single star stay inside one path segment", () => {
    const pattern = globToRegExp("src/*")
    expect(pattern.test("src/index.ts")).toBe(true)
    expect(pattern.test("src/api/index.ts")).toBe(false)
  })

  it("lets a double star cross path segments", () => {
    const pattern = globToRegExp("src/**")
    expect(pattern.test("src/api/index.ts")).toBe(true)
    expect(pattern.test("src/index.ts")).toBe(true)
    expect(pattern.test("test/index.ts")).toBe(false)
  })

  it("treats a question mark as exactly one character", () => {
    const pattern = globToRegExp("v?.ts")
    expect(pattern.test("v1.ts")).toBe(true)
    expect(pattern.test("v12.ts")).toBe(false)
  })

  it("escapes regular expression characters", () => {
    const pattern = globToRegExp("a.b+c.ts")
    expect(pattern.test("a.b+c.ts")).toBe(true)
    expect(pattern.test("axbbc.ts")).toBe(false)
  })

  it("anchors the whole value", () => {
    const pattern = globToRegExp("src")
    expect(pattern.test("src/index.ts")).toBe(false)
    expect(pattern.test("src")).toBe(true)
  })
})

describe("matchesGlob", () => {
  it("matches a nested path under a double star", () => {
    expect(matchesGlob("src/api/**", "src/api/search.ts")).toBe(true)
  })

  it("does not match a path outside the pattern", () => {
    expect(matchesGlob("src/api/**", "src/web/page.ts")).toBe(false)
  })
})

describe("normalizePath", () => {
  it("drops a leading dot slash and a trailing slash", () => {
    expect(normalizePath("./src/api/")).toBe("src/api")
  })

  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("src\\api\\x.ts")).toBe("src/api/x.ts")
  })
})

describe("relativeToRoot", () => {
  it("makes a path under the root relative", () => {
    expect(relativeToRoot("/repo", "/repo/src/api/x.ts")).toBe("src/api/x.ts")
  })

  it("keeps a path outside the root absolute so it cannot match by accident", () => {
    expect(relativeToRoot("/repo", "/elsewhere/x.ts")).toBe("/elsewhere/x.ts")
  })
})
