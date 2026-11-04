import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { relativizeRemotes, toAvatarAsset } from "@/lib/optimodel/avatar-asset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IndexJson = {
	avatars: Array<{ id: string; dir: string; name?: string }>;
};

async function loadIndex(): Promise<IndexJson> {
	const raw = await readFile(
		join(process.cwd(), "public/spatialreal/index.json"),
		"utf8",
	);
	return JSON.parse(raw) as IndexJson;
}

export async function GET(
	_req: Request,
	ctx: { params: Promise<{ id: string }> },
) {
	const { id: rawId } = await ctx.params;
	const characterId = decodeURIComponent(rawId);

	try {
		const index = await loadIndex();
		const byId = index.avatars.find((a) => a.id === characterId);
		const byName = index.avatars.find((a) => a.name === characterId);
		const entry = byId ?? byName;
		if (!entry) {
			return NextResponse.json(
				{
					errors: [
						{
							title: "avatar not found",
							detail: `No local OptiModel cache for ${characterId}`,
						},
					],
				},
				{ status: 404 },
			);
		}

		const metaPath = join(
			process.cwd(),
			"public/spatialreal",
			entry.dir,
			"character.json",
		);
		const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<
			string,
			unknown
		>;
		// Always path-absolute (`/spatialreal/...`). Never emit
		// https://localhost:3000/... — Docker/SITE_URL absolutizing breaks prod.
		const payload = relativizeRemotes(toAvatarAsset(meta, entry.dir));

		return NextResponse.json(payload, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json(
			{
				errors: [{ title: "avatar load failed", detail: message }],
			},
			{ status: 500 },
		);
	}
}
