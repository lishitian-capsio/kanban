import { describe, expect, it } from "vitest";

import { classifyFileCategory, detectMimeType } from "../../../src/files/file-mime";

describe("detectMimeType", () => {
	it("derives the mime type from a file name extension", () => {
		expect(detectMimeType("diagram.png")).toBe("image/png");
		expect(detectMimeType("report.pdf")).toBe("application/pdf");
		expect(detectMimeType("notes.txt")).toBe("text/plain");
	});

	it("falls back to application/octet-stream for unknown or extension-less names", () => {
		expect(detectMimeType("Makefile")).toBe("application/octet-stream");
		expect(detectMimeType("mystery.zzzzz")).toBe("application/octet-stream");
	});

	it("prefers a non-empty explicit override over the name-derived type", () => {
		expect(detectMimeType("photo.bin", "image/jpeg")).toBe("image/jpeg");
		expect(detectMimeType("photo.png", "  ")).toBe("image/png");
		expect(detectMimeType("photo.png", null)).toBe("image/png");
	});
});

describe("classifyFileCategory", () => {
	it("maps top-level mime types to coarse categories", () => {
		expect(classifyFileCategory("image/png")).toBe("image");
		expect(classifyFileCategory("audio/mpeg")).toBe("audio");
		expect(classifyFileCategory("video/mp4")).toBe("video");
		expect(classifyFileCategory("text/markdown")).toBe("text");
	});

	it("treats office/pdf documents as the document category", () => {
		expect(classifyFileCategory("application/pdf")).toBe("document");
		expect(classifyFileCategory("application/msword")).toBe("document");
		expect(classifyFileCategory("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
			"document",
		);
	});

	it("treats compressed containers as the archive category", () => {
		expect(classifyFileCategory("application/zip")).toBe("archive");
		expect(classifyFileCategory("application/x-tar")).toBe("archive");
		expect(classifyFileCategory("application/gzip")).toBe("archive");
	});

	it("treats text-bearing application types as text", () => {
		expect(classifyFileCategory("application/json")).toBe("text");
		expect(classifyFileCategory("application/xml")).toBe("text");
	});

	it("falls back to other for unrecognized binary types", () => {
		expect(classifyFileCategory("application/octet-stream")).toBe("other");
		expect(classifyFileCategory("application/vnd.some.proprietary.thing")).toBe("other");
	});
});
