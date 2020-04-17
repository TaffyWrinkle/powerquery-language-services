// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as PQP from "@microsoft/powerquery-parser";
import { Diagnostic, DiagnosticSeverity, Position, Range, TextDocument } from "vscode-languageserver-types";

import { WorkspaceCache } from ".";

export interface ValidationResult {
    readonly hasErrors: boolean;
    readonly diagnostics: Diagnostic[];
}

export function validate(document: TextDocument): ValidationResult {
    const triedLexParse: PQP.Task.TriedLexParse = WorkspaceCache.getTriedLexParse(document);
    let diagnostics: Diagnostic[] = [];
    if (PQP.ResultUtils.isErr(triedLexParse)) {
        const lexOrParseError: PQP.LexError.TLexError | PQP.ParseError.TParseError = triedLexParse.error;
        if (lexOrParseError instanceof PQP.ParseError.ParseError) {
            const maybeDiagnostic: undefined | Diagnostic = maybeParseErrorToDiagnostic(lexOrParseError);
            if (maybeDiagnostic !== undefined) {
                diagnostics = [maybeDiagnostic];
            }
        } else if (PQP.LexError.isTInnerLexError(lexOrParseError.innerError)) {
            const maybeLexerErrorDiagnostics: undefined | Diagnostic[] = maybeLexErrorToDiagnostics(
                lexOrParseError.innerError,
            );
            if (maybeLexerErrorDiagnostics !== undefined) {
                diagnostics = maybeLexerErrorDiagnostics;
            }
        }
    }
    return {
        hasErrors: diagnostics.length > 0,
        diagnostics,
    };
}

function maybeLexErrorToDiagnostics(error: PQP.LexError.TInnerLexError): undefined | Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    // TODO: handle other types of lexer errors
    if (error instanceof PQP.LexError.ErrorLineMapError) {
        for (const errorLine of error.errorLineMap.values()) {
            const innerError: PQP.LexError.TInnerLexError = errorLine.error.innerError;
            if ((innerError as any).graphemePosition) {
                const graphemePosition: PQP.StringUtils.GraphemePosition = (innerError as any).graphemePosition;
                const message: string = innerError.message;
                const position: Position = {
                    line: graphemePosition.lineNumber,
                    character: graphemePosition.lineCodeUnit,
                };
                // TODO: "lex" errors aren't that useful to display to end user. Should we make it more generic?
                diagnostics.push({
                    message,
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: position,
                        end: position,
                    },
                });
            }
        }
    }
    return diagnostics.length ? diagnostics : undefined;
}

function maybeParseErrorToDiagnostic(error: PQP.ParseError.ParseError): undefined | Diagnostic {
    const innerError: PQP.ParseError.TInnerParseError = error.innerError;
    const message: string = error.message;
    let maybeErrorToken: undefined | PQP.Language.Token;
    if (
        (innerError instanceof PQP.ParseError.ExpectedAnyTokenKindError ||
            innerError instanceof PQP.ParseError.ExpectedTokenKindError) &&
        innerError.maybeFoundToken !== undefined
    ) {
        maybeErrorToken = innerError.maybeFoundToken.token;
    } else if (innerError instanceof PQP.ParseError.InvalidPrimitiveTypeError) {
        maybeErrorToken = innerError.token;
    } else if (innerError instanceof PQP.ParseError.UnterminatedBracketError) {
        maybeErrorToken = innerError.openBracketToken;
    } else if (innerError instanceof PQP.ParseError.UnterminatedParenthesesError) {
        maybeErrorToken = innerError.openParenthesesToken;
    } else if (innerError instanceof PQP.ParseError.UnusedTokensRemainError) {
        maybeErrorToken = innerError.firstUnusedToken;
    } else {
        maybeErrorToken = undefined;
    }

    let range: Range;
    if (maybeErrorToken !== undefined) {
        range = {
            start: {
                line: maybeErrorToken.positionStart.lineNumber,
                character: maybeErrorToken.positionStart.lineCodeUnit,
            },
            end: {
                line: maybeErrorToken.positionEnd.lineNumber,
                character: maybeErrorToken.positionEnd.lineCodeUnit,
            },
        };
    } else {
        const parseContextState: PQP.ParseContext.State = error.state.contextState;
        const maybeRoot: undefined | PQP.ParseContext.Node = parseContextState.root.maybeNode;
        if (maybeRoot === undefined) {
            return undefined;
        }

        const maybeLeaf: undefined | PQP.Language.Ast.TNode = PQP.NodeIdMapUtils.maybeRightMostLeaf(
            error.state.contextState.nodeIdMapCollection,
            maybeRoot.id,
        );
        if (maybeLeaf === undefined) {
            return undefined;
        }
        const leafTokenRange: PQP.Language.TokenRange = maybeLeaf.tokenRange;

        range = {
            start: {
                line: leafTokenRange.positionStart.lineNumber,
                character: leafTokenRange.positionStart.lineCodeUnit,
            },
            end: {
                line: leafTokenRange.positionEnd.lineNumber,
                character: leafTokenRange.positionEnd.lineCodeUnit,
            },
        };
    }

    return {
        message,
        severity: DiagnosticSeverity.Error,
        range,
    };
}