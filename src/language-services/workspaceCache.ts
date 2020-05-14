// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as PQP from "@microsoft/powerquery-parser";

import type { TextDocument } from "vscode-languageserver-textdocument";
import { Position } from "vscode-languageserver-types";

const lexerStateCache: Map<string, PQP.Lexer.State> = new Map();
const lexerSnapshotCache: Map<string, PQP.TriedLexerSnapshot> = new Map();
const triedLexParseCache: Map<string, PQP.Task.TriedLexParse> = new Map();
const triedInspectionCache: Map<string, InspectionMap> = new Map();

// Notice that the value type for WeakMap includes undefined.
// Take the scenario where an inspection was requested on a document that was not parsable,
// then createTriedInspection would return undefined as you can't inspect something that wasn't parsed.
// If we used WeakMap.get(...) we wouldn't know if an undefined was returned because of a cache miss
// or that we we couldn't do an inspection.
type InspectionMap = WeakMap<Position, PQP.Task.TriedInspection | undefined>;

const allCaches: Map<string, any>[] = [lexerSnapshotCache, lexerStateCache, triedLexParseCache, triedInspectionCache];

// TODO: is the position key valid for a single intellisense operation,
// or would it be the same for multiple invocations?
export function close(textDocument: TextDocument): void {
    allCaches.forEach(map => {
        map.delete(textDocument.uri);
    });
}

export function update(textDocument: TextDocument): void {
    // TODO: support incremental lexing
    // TODO: premptively prepare cache on background thread?
    // TODO: use document version
    close(textDocument);
}

export function getLexerState(textDocument: TextDocument): PQP.Lexer.State {
    return getOrCreate(lexerStateCache, textDocument, createLexerState);
}

export function getTriedLexerSnapshot(textDocument: TextDocument): PQP.TriedLexerSnapshot {
    return getOrCreate(lexerSnapshotCache, textDocument, createTriedLexerSnapshot);
}

export function getTriedLexParse(textDocument: TextDocument): PQP.Task.TriedLexParse {
    return getOrCreate(triedLexParseCache, textDocument, createTriedLexParse);
}

// We can't easily reuse getOrCreate because inspections require a position argument.
// This results in a double layer cache.
export function maybeTriedInspection(
    textDocument: TextDocument,
    position: Position,
): PQP.Task.TriedInspection | undefined {
    const cacheKey: string = textDocument.uri;
    const maybePositionCache:
        | undefined
        | WeakMap<Position, PQP.Task.TriedInspection | undefined> = triedInspectionCache.get(cacheKey);

    let positionCache: WeakMap<Position, PQP.Task.TriedInspection | undefined>;
    // document has been inspected before
    if (maybePositionCache !== undefined) {
        positionCache = maybePositionCache;
    } else {
        positionCache = new WeakMap();
        triedInspectionCache.set(textDocument.uri, positionCache);
    }

    if (positionCache.has(position)) {
        return positionCache.get(position);
    } else {
        const value: PQP.Task.TriedInspection | undefined = createTriedInspection(textDocument, position);
        positionCache.set(position, value);
        return value;
    }
}

function getOrCreate<T>(
    cache: Map<string, T>,
    textDocument: TextDocument,
    factoryFn: (textDocument: TextDocument) => T,
): T {
    const cacheKey: string = textDocument.uri;
    const maybeValue: T | undefined = cache.get(cacheKey);

    if (maybeValue === undefined) {
        const value: T = factoryFn(textDocument);
        cache.set(cacheKey, value);
        return value;
    } else {
        return maybeValue;
    }
}

function createLexerState(textDocument: TextDocument): PQP.Lexer.State {
    // TODO (Localization): update settings based on locale
    return PQP.Lexer.stateFrom(PQP.DefaultSettings, textDocument.getText());
}

function createTriedLexerSnapshot(textDocument: TextDocument): PQP.TriedLexerSnapshot {
    const lexerState: PQP.Lexer.State = getLexerState(textDocument);
    return PQP.LexerSnapshot.tryFrom(lexerState);
}

function createTriedLexParse(textDocument: TextDocument): PQP.Task.TriedLexParse {
    const triedLexerSnapshot: PQP.TriedLexerSnapshot = getTriedLexerSnapshot(textDocument);
    if (PQP.ResultUtils.isErr(triedLexerSnapshot)) {
        return triedLexerSnapshot;
    }
    const lexerSnapshot: PQP.LexerSnapshot = triedLexerSnapshot.value;

    // TODO (Localization): update settings based on locale
    const triedParse: PQP.TriedParse = PQP.Task.tryParse(PQP.DefaultSettings, lexerSnapshot);
    if (PQP.ResultUtils.isErr(triedParse)) {
        return triedParse;
    }
    const parseOk: PQP.ParseOk = triedParse.value;

    return PQP.ResultUtils.okFactory({
        ...parseOk,
        lexerSnapshot,
    });
}

// We're allowed to return undefined because if a document wasn't parsed
// then there's no way to perform an inspection.
function createTriedInspection(textDocument: TextDocument, position: Position): PQP.Task.TriedInspection | undefined {
    const triedLexParse: PQP.Task.TriedLexParse = getTriedLexParse(textDocument);
    if (
        PQP.ResultUtils.isErr(triedLexParse) &&
        (triedLexParse.error instanceof PQP.CommonError.CommonError ||
            triedLexParse.error instanceof PQP.LexError.LexError)
    ) {
        return undefined;
    }

    const maybeTriedParse: PQP.TriedParse | undefined = PQP.Task.maybeTriedParseFromTriedLexParse(triedLexParse);
    if (maybeTriedParse === undefined) {
        return undefined;
    }

    const triedParse: PQP.TriedParse = maybeTriedParse;
    const pqpPosition: PQP.Inspection.Position = {
        lineNumber: position.line,
        lineCodeUnit: position.character,
    };

    return PQP.Task.tryInspection(PQP.DefaultSettings, triedParse, pqpPosition);
}
