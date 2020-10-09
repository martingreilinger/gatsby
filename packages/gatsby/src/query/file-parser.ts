import { codeFrameColumns } from "@babel/code-frame"
import { NodePath } from "@babel/core"
import traverse from "@babel/traverse"
import { CallExpression, Node } from "@babel/types"
import {
  EmptyGraphQLTagError,
  followVariableDeclarations,
  getGraphQLTag,
  GraphQLSyntaxError,
  StringInterpolationNotAllowedError,
} from "babel-plugin-remove-graphql-queries"
import crypto from "crypto"
import fs from "fs-extra"
import { camelCase, uniqBy } from "lodash"
import slugify from "slugify"
import type { DocumentNode } from "graphql"
import report from "gatsby-cli/lib/reporter"
import { locInGraphQlToLocInFile } from "./error-parser"
import { babelParseToAst } from "../utils/babel-parse-to-ast"
import apiRunnerNode from "../utils/api-runner-node"
import { boundActionCreators } from "../redux/actions"
import {
  Identifier,
  TaggedTemplateExpression,
  JSXIdentifier,
  VariableDeclarator,
} from "@babel/types"
import { ILocationPosition } from "gatsby-cli/src/structured-errors/types"

interface IQueryName {
  name?: {
    value: string
    kind: `Name`
  }
}

interface IErrorLocation {
  start: ILocationPosition
  end?: ILocationPosition
}
type ErrorLocation = IErrorLocation | null
type CodeFrame = string | null

export interface IParseError {
  id: string
  filePath?: string
  context?: {
    filePath?: string
    codeFrame?: CodeFrame
    sourceMessage?: string
  }
  location?: ErrorLocation
  error?: NodeJS.ErrnoException
}

type AddParseErrorFunction = (...error: Array<IParseError>) => unknown

/**
 * Add autogenerated query name if it wasn't defined by user.
 */
const generateQueryName = (
  def: IQueryName,
  hash: string,
  file: string
): IQueryName => {
  if (!def.name || !def.name.value) {
    const slugified = slugify(file, {
      replacement: ` `,
      lower: false,
    })
    def.name = {
      value: `${camelCase(slugified)}${hash}`,
      kind: `Name`,
    }
  }
  return def
}

// taken from `babel-plugin-remove-graphql-queries`, in the future import from there
// NOTE: During JS -> TS migration I noticed that there is a logical difference.
//       This implantation has no early return unlike the one from `babel-plugin-remove-graphql-queries`.
//       Drop in replacement is not possible without changing the logic!
function isUseStaticQuery(path: NodePath<CallExpression>): boolean {
  const callee = path.node.callee
  if (
    callee.type === `MemberExpression` &&
    (callee.property as Identifier).name === `useStaticQuery`
  ) {
    return (path.get(`callee`).get(`object`) as NodePath).referencesImport(
      `gatsby`,
      ``
    )
  } else if ((callee as Identifier).name === `useStaticQuery`) {
    return path.get(`callee`).referencesImport(`gatsby`, ``)
  }

  return false
}

const warnForUnknownQueryVariable = (
  varName: string,
  file: string,
  usageFunction: string
): void =>
  report.warn(
    `\nWe were unable to find the declaration of variable "${varName}", which you passed as the "query" prop into the ${usageFunction} declaration in "${file}".

Perhaps the variable name has a typo?

Also note that we are currently unable to use queries defined in files other than the file where the ${usageFunction} is defined. If you're attempting to import the query, please move it into "${file}". If being able to import queries from another file is an important capability for you, we invite your help fixing it.\n`
  )

async function parseToAst(
  filePath: string,
  fileStr: string,
  addError: AddParseErrorFunction,
  parentSpan?: object
): Promise<Node | null> {
  let ast

  // Preprocess and attempt to parse source; return an AST if we can, log an
  // error if we can't.
  const transpiled = await apiRunnerNode(`preprocessSource`, {
    filename: filePath,
    contents: fileStr,
    parentSpan: parentSpan,
  })
  if (transpiled && transpiled.length) {
    for (const item of transpiled) {
      try {
        const tmp = babelParseToAst(item, filePath)
        ast = tmp
        break
      } catch (error) {
        boundActionCreators.queryExtractionGraphQLError({
          componentPath: filePath,
        })
        continue
      }
    }
    if (ast === undefined) {
      addError({
        id: `85912`,
        filePath,
        context: {
          filePath,
        },
      })
      boundActionCreators.queryExtractionGraphQLError({
        componentPath: filePath,
      })

      return null
    }
  } else {
    try {
      ast = babelParseToAst(fileStr, filePath)
    } catch (error) {
      boundActionCreators.queryExtractionBabelError({
        componentPath: filePath,
        error,
      })

      addError({
        id: `85911`,
        filePath,
        context: {
          filePath,
        },
      })

      return null
    }
  }

  return ast
}

const warnForGlobalTag = (file: string): void =>
  report.warn(
    `Using the global \`graphql\` tag is deprecated, and will not be supported in v3.\n` +
      `Import it instead like:  import { graphql } from 'gatsby' in file:\n` +
      file
  )

export interface IGraphQLDocumentInFile {
  filePath: string
  doc: DocumentNode
  templateLoc: string
  text: string
  hash: string
  isHook: boolean
  isStaticQuery: boolean
}

const isTaggedTemplateExpressionWithName = (
  varPath: NodePath<VariableDeclarator>,
  varName: string
): boolean =>
  (varPath.node.id as Identifier).name === varName &&
  varPath.node.init?.type === `TaggedTemplateExpression`

async function findGraphQLTags(
  file: string,
  text: string,
  addError: AddParseErrorFunction,
  parentSpan?: object
): Promise<Array<IGraphQLDocumentInFile>> {
  return new Promise((resolve, reject) => {
    parseToAst(file, text, addError, parentSpan)
      .then(ast => {
        const documents: Array<IGraphQLDocumentInFile> = []
        if (!ast) {
          resolve(documents)
          return
        }

        /**
         * A map of graphql documents to unique locations.
         *
         * A graphql document's unique location is made of:
         *
         *  - the location of the graphql template literal that contains the document, and
         *  - the document's location within the graphql template literal
         *
         * This is used to prevent returning duplicated documents.
         */
        const documentLocations = new WeakMap()

        const extractStaticQuery = (
          taggedTemplateExpressPath: NodePath<TaggedTemplateExpression>,
          isHook = false
        ): void => {
          const { ast: gqlAst, text, hash, isGlobal } = getGraphQLTag(
            taggedTemplateExpressPath
          )
          if (!gqlAst) return

          if (isGlobal) warnForGlobalTag(file)

          gqlAst.definitions.forEach(def => generateQueryName(def, hash, file))

          let templateLoc

          taggedTemplateExpressPath.traverse({
            TemplateElement(templateElementPath) {
              templateLoc = templateElementPath.node.loc
            },
          })

          const docInFile = {
            filePath: file,
            doc: gqlAst,
            text: text,
            hash: hash,
            isStaticQuery: true,
            isHook,
            templateLoc,
          }

          documentLocations.set(
            docInFile,
            `${taggedTemplateExpressPath.node.start}-${gqlAst.loc.start}`
          )

          documents.push(docInFile)
        }

        // Look for queries in <StaticQuery /> elements.
        traverse(ast, {
          JSXElement(path) {
            if (
              (path.node.openingElement.name as JSXIdentifier).name !==
              `StaticQuery`
            ) {
              return
            }

            // astexplorer.com link I (@kyleamathews) used when prototyping this algorithm
            // https://astexplorer.net/#/gist/ab5d71c0f08f287fbb840bf1dd8b85ff/2f188345d8e5a4152fe7c96f0d52dbcc6e9da466
            path.traverse({
              JSXAttribute(jsxPath) {
                if (jsxPath.node.name.name !== `query`) {
                  return
                }
                jsxPath.traverse({
                  // Assume the query is inline in the component and extract that.
                  TaggedTemplateExpression(templatePath) {
                    extractStaticQuery(templatePath)
                  },
                  // Also see if it's a variable that's passed in as a prop
                  // and if it is, go find it.
                  Identifier(identifierPath) {
                    if (identifierPath.node.name !== `graphql`) {
                      const varName = identifierPath.node.name
                      let found = false
                      traverse(ast, {
                        VariableDeclarator(varPath) {
                          if (
                            isTaggedTemplateExpressionWithName(varPath, varName)
                          ) {
                            varPath.traverse({
                              TaggedTemplateExpression(templatePath) {
                                found = true
                                extractStaticQuery(templatePath)
                              },
                            })
                          }
                        },
                      })
                      if (!found) {
                        warnForUnknownQueryVariable(
                          varName,
                          file,
                          `<StaticQuery>`
                        )
                      }
                    }
                  },
                })
              },
            })
            return
          },
        })

        // Look for queries in useStaticQuery hooks.
        traverse(ast, {
          CallExpression(hookPath) {
            if (!isUseStaticQuery(hookPath)) return

            const firstArg = hookPath.get(`arguments`)[0]

            // Assume the query is inline in the component and extract that.
            if (firstArg.isTaggedTemplateExpression()) {
              extractStaticQuery(firstArg, true)
              // Also see if it's a variable that's passed in as a prop
              // and if it is, go find it.
            } else if (firstArg.isIdentifier()) {
              if (
                firstArg.node.name !== `graphql` &&
                firstArg.node.name !== `useStaticQuery`
              ) {
                const varName = firstArg.node.name
                let found = false
                traverse(ast, {
                  VariableDeclarator(varPath) {
                    if (isTaggedTemplateExpressionWithName(varPath, varName)) {
                      varPath.traverse({
                        TaggedTemplateExpression(templatePath) {
                          found = true
                          extractStaticQuery(templatePath, true)
                        },
                      })
                    }
                  },
                })
                if (!found) {
                  warnForUnknownQueryVariable(varName, file, `useStaticQuery`)
                }
              }
            }
          },
        })

        function TaggedTemplateExpression(
          innerPath: NodePath<TaggedTemplateExpression>
        ): void {
          const { ast: gqlAst, isGlobal, hash, text } = getGraphQLTag(innerPath)
          if (!gqlAst) return

          if (isGlobal) warnForGlobalTag(file)

          gqlAst.definitions.forEach(def => {
            generateQueryName(def, hash, file)
          })

          let templateLoc
          innerPath.traverse({
            TemplateElement(templateElementPath) {
              templateLoc = templateElementPath.node.loc
            },
          })

          const docInFile = {
            filePath: file,
            doc: gqlAst,
            text: text,
            hash: hash,
            isStaticQuery: false,
            isHook: false,
            templateLoc,
          }

          documentLocations.set(
            docInFile,
            `${innerPath.node.start}-${gqlAst.loc.start}`
          )

          documents.push(docInFile)
        }

        // When a component has a StaticQuery we scan all of its exports and follow those exported variables
        // to determine if they lead to this static query (via tagged template literal)
        traverse(ast, {
          ExportNamedDeclaration(path) {
            // Skipping the edge case of re-exporting (i.e. "export { bar } from 'Bar'")
            // (it is handled elsewhere for queries, see usages of warnForUnknownQueryVariable)
            if (path.node.source) {
              return
            }
            path.traverse({
              TaggedTemplateExpression,
              ExportSpecifier(path) {
                const binding = followVariableDeclarations(
                  path.scope.getBinding(path.node.local.name)
                )
                binding.path.traverse({ TaggedTemplateExpression })
              },
            })
          },
        })

        // Remove duplicate queries
        const uniqueQueries = uniqBy(documents, q => documentLocations.get(q))

        resolve(uniqueQueries)
      })
      .catch(reject)
  })
}

const cache = {}

export class FileParser {
  constructor(private parentSpan?: object) {}

  async parseFile(
    file: string,
    addError: AddParseErrorFunction
  ): Promise<Array<IGraphQLDocumentInFile> | null> {
    let text
    try {
      text = await fs.readFile(file, `utf8`)
    } catch (err) {
      addError({
        id: `85913`,
        filePath: file,
        context: {
          filePath: file,
        },
        error: err,
      })

      boundActionCreators.queryExtractionGraphQLError({
        componentPath: file,
      })
      return null
    }

    // We do a quick check so we can exit early if this is a file we're not interested in.
    // We only process files that either include graphql, or static images
    if (!text.includes(`graphql`) && !text.includes(`gatsby-plugin-image`))
      return null
    const hash = crypto
      .createHash(`md5`)
      .update(file)
      .update(text)
      .digest(`hex`)

    try {
      const astDefinitions =
        cache[hash] ||
        (cache[hash] = await findGraphQLTags(
          file,
          text,
          addError,
          this.parentSpan
        ))

      // If any AST definitions were extracted, report success.
      // This can mean there is none or there was a babel error when
      // we tried to extract the graphql AST.
      if (astDefinitions.length > 0) {
        boundActionCreators.queryExtractedBabelSuccess({
          componentPath: file,
        })
      }

      return astDefinitions
    } catch (err) {
      // default error
      let structuredError: IParseError = {
        id: `85915`,
        context: {
          filePath: file,
        },
      }

      if (err instanceof StringInterpolationNotAllowedError) {
        const location = {
          start: err.interpolationStart,
          end: err.interpolationEnd,
        }
        structuredError = {
          id: `85916`,
          location,
          context: {
            codeFrame: codeFrameColumns(text, location, {
              highlightCode: process.env.FORCE_COLOR !== `0`,
            }),
          },
        }
      } else if (err instanceof EmptyGraphQLTagError) {
        const location = err.templateLoc
          ? {
              start: err.templateLoc.start,
              end: err.templateLoc.end,
            }
          : null

        structuredError = {
          id: `85917`,
          location,
          context: {
            codeFrame: location
              ? codeFrameColumns(text, location, {
                  highlightCode: process.env.FORCE_COLOR !== `0`,
                })
              : null,
          },
        }
      } else if (err instanceof GraphQLSyntaxError) {
        const location = {
          start: locInGraphQlToLocInFile(
            err.templateLoc,
            err.originalError.locations[0]
          ),
        }

        structuredError = {
          id: `85918`,
          location,
          context: {
            codeFrame: location
              ? codeFrameColumns(text, location, {
                  highlightCode: process.env.FORCE_COLOR !== `0`,
                  message: err.originalError.message,
                })
              : null,
            sourceMessage: err.originalError.message,
          },
        }
      }

      addError({
        ...structuredError,
        filePath: file,
      })

      boundActionCreators.queryExtractionGraphQLError({
        componentPath: file,
      })
      return null
    }
  }

  async parseFiles(
    files: Array<string>,
    addError: AddParseErrorFunction
  ): Promise<Array<IGraphQLDocumentInFile>> {
    const documents: Array<IGraphQLDocumentInFile> = []

    return Promise.all(
      files.map(file =>
        this.parseFile(file, addError).then(docs =>
          documents.push(...(docs || []))
        )
      )
    ).then(() => documents)
  }
}
