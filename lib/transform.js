'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

// ── Public ────────────────────────────────────────────────────────────────────

// Transform every .md / .mdx / .txt file under sourceDir into the G2-formatted
// equivalent in outputDir, preserving relative paths. Non-text files are
// skipped. Uses the user's `claude` CLI with a fixed harness prompt that
// includes the reformat-note.txt spec.
//
// opts:
//   sourceDir     absolute path
//   outputDir     absolute path
//   singleFile?   if set, only transform this one file (absolute path)
//   onFile?       callback(rel, i, total)
//   onLog?        callback(line)
async function transformDocs(opts) {
	const { sourceDir, outputDir, singleFile } = opts
	const onFile = opts.onFile || (() => {})
	const onLog = opts.onLog || (() => {})

	const spec = loadSpec(onLog)
	const files = singleFile ? [singleFile] : walk(sourceDir)

	onLog(`found ${files.length} file(s) to transform`)

	for (let i = 0; i < files.length; i++) {
		const abs = files[i]
		const rel = path.relative(sourceDir, abs)
		onFile(rel, i + 1, files.length)
		try {
			const content = fs.readFileSync(abs, 'utf8')
			const transformed = await runClaude(spec, content, onLog)
			const destRel = rel.replace(/\.(mdx|txt)$/i, '.md')
			const destAbs = path.join(outputDir, destRel)
			fs.mkdirSync(path.dirname(destAbs), { recursive: true })
			fs.writeFileSync(destAbs, transformed, 'utf8')
		} catch (err) {
			onLog(`ERROR ${rel}: ${err.message}`)
		}
	}
}

// ── Internals ─────────────────────────────────────────────────────────────────

function walk(dir) {
	const out = []
	if (!fs.existsSync(dir)) return out
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.name.startsWith('.')) continue
		const full = path.join(dir, ent.name)
		if (ent.isDirectory()) {
			out.push(...walk(full))
		} else if (ent.isFile() && /\.(md|mdx|txt)$/i.test(ent.name)) {
			out.push(full)
		}
	}
	return out
}

function loadSpec(onLog) {
	// The reformat-note.txt ships with nutshell-server. Resolve it via require.
	try {
		const pkgPath = require.resolve('nutshell-server/package.json')
		const promptPath = path.join(path.dirname(pkgPath), 'prompts', 'reformat-note.txt')
		return fs.readFileSync(promptPath, 'utf8')
	} catch (err) {
		onLog(`WARN: could not load nutshell-server spec: ${err.message}; falling back to inline`)
		return FALLBACK_SPEC
	}
}

// Invoke the user's `claude` CLI in one-shot mode. Passes the harness on stdin
// and reads the transformed note from stdout. The CLI must be installed and
// authenticated; we don't manage auth here.
function runClaude(spec, content, onLog) {
	return new Promise((resolve, reject) => {
		const prompt = buildPrompt(spec, content)
		const proc = spawn('claude', ['-p', prompt], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		})
		let out = ''
		let err = ''
		proc.stdout.on('data', (b) => (out += b.toString('utf8')))
		proc.stderr.on('data', (b) => (err += b.toString('utf8')))
		proc.on('error', (e) => {
			if (e.code === 'ENOENT') {
				reject(
					new Error(
						'claude CLI not found on PATH. Install Claude Code from claude.ai/code.',
					),
				)
			} else {
				reject(e)
			}
		})
		proc.on('close', (code) => {
			if (code === 0) {
				resolve(out.trim() + '\n')
			} else {
				onLog(`claude stderr: ${err}`)
				reject(new Error(`claude exited with code ${code}`))
			}
		})
	})
}

function buildPrompt(spec, content) {
	return [
		spec,
		'',
		'---',
		'',
		'Reformat the following note under these rules. Output only the reformatted note — no preamble, no code fences.',
		'',
		content,
	].join('\n')
}

const FALLBACK_SPEC = `You are a reformatting engine for the Even Realities G2 heads-up display. Rewrite the user's note into a HUD-friendly markdown format with a single # Title, concise ## sections, short paragraphs, and bulleted lists. Strip all inline formatting (bold, italic, code, tables, links, HTML) and keep every fact, number, and example. Output only the reformatted note.`

module.exports = { transformDocs }
