import { ClientOptions, Exists } from './types'
import {
  GraphQLObjectType,
  GraphQLScalarType,
  Kind,
  OperationTypeNode,
  print,
  execute,
  subscribe,
  GraphQLField,
  GraphQLSchema,
  buildSchema,
} from 'graphql'
import mapAsyncIterator from './utils/mapAsyncIterator'
import { mapValues } from './utils/mapValues'
import gql from 'graphql-tag'
import { getTypesAndWhere } from './utils'
const log = require('debug')('binding')
import { sign } from 'jsonwebtoken'
import { BatchedGraphQLClient } from 'http-link-dataloader'
// to make the TS compiler happy

let instructionId = 0

export interface InstructionsMap {
  [key: string]: Instruction[]
}

export interface Instruction {
  fieldName: string
  args?: any
  field: GraphQLField<any, any>
  fragment: string | object
  typeName: string
}

export class Client {
  // subscription: SubscriptionMap
  types: any
  query: any
  $subscribe: any
  $exists: any
  debug
  mutation: any
  endpoint: string
  secret?: string
  client: BatchedGraphQLClient
  schema: GraphQLSchema
  token: string
  currentInstructions: InstructionsMap = {}

  constructor({ typeDefs, endpoint, secret, debug }: ClientOptions) {
    this.debug = debug
    this.schema = buildSchema(typeDefs)
    this.endpoint = endpoint
    this.secret = secret

    this.buildMethods()

    const token = secret ? sign({}, secret!) : undefined

    this.$exists = this.buildExists()
    this.token = token
    this.client = new BatchedGraphQLClient(endpoint, {
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
          }
        : {},
    })
  }

  getOperation(instructions) {
    return instructions[0].typeName.toLowerCase()
  }

  processInstructions = async (id: number): Promise<any> => {
    log('process instructions')
    const instructions = this.currentInstructions[id]

    const { ast, variables } = this.generateSelections(instructions)
    log('generated selections')
    const { variableDefinitions, ...restAst } = ast
    const operation = this.getOperation(instructions) as OperationTypeNode

    const document = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation,
          directives: [],
          variableDefinitions,
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [restAst],
          },
        },
      ],
    }
    if (this.debug) {
      console.log(`\nQuery:`)
      const query = print(document)
      console.log(query)
      if (variables && Object.keys(variables).length > 0) {
        console.log('Variables:')
        console.log(JSON.stringify(variables))
      }
    }

    log('printed / before')
    const result = await this.execute(operation, document, variables)
    log('executed')

    if (operation === 'subscription') {
      return this.mapSubscriptionPayload(result, instructions)
    }

    return this.extractPayload(result, instructions)
  }

  mapSubscriptionPayload(result, instructions) {
    debugger
    return mapAsyncIterator(result, res =>
      this.extractPayload(res, instructions),
    )
  }

  extractPayload(result, instructions) {
    let pointer = result.data
    let count = 0
    while (
      pointer &&
      typeof pointer === 'object' &&
      !Array.isArray(pointer) &&
      count < instructions.length
    ) {
      pointer = pointer[Object.keys(pointer)[0]]
      count++
    }
    log('unpack it')

    return pointer
  }

  execute(operation, document, variables) {
    if (operation === 'subscription') {
      return subscribe(this.schema, document, {}, {}, variables)
    }
    return execute(this.schema, document, {}, {}, variables) as any
  }

  then = async (id, resolve, reject) => {
    let result
    try {
      // const before = Date.now()
      result = await this.processInstructions(id)
      // console.log(`then: ${Date.now() - before}`)
      this.currentInstructions[id] = []
      resolve(result)
    } catch (e) {
      this.currentInstructions[id] = []
      reject(e)
    }
    return result
  }

  catch = async (id, reject) => {
    try {
      await this.processInstructions(id)
    } catch (e) {
      this.currentInstructions[id] = []
      reject(e)
    }
  }

  generateSelections(instructions) {
    const variableDefinitions: any[] = []
    const variables = {}
    let variableCounter = {}

    const ast = instructions.reduceRight((acc, instruction, index) => {
      let args: any[] = []

      if (instruction.args && Object.keys(instruction.args).length > 0) {
        Object.entries(instruction.args).forEach(([name, value]) => {
          let variableName
          if (typeof variableCounter[name] === 'undefined') {
            variableName = name
            variableCounter[name] = 0
          } else {
            variableCounter[name]++
            variableName = `${name}_${variableCounter[name]}`
          }
          variables[variableName] = value
          const inputArg = instruction.field.args.find(arg => arg.name === name)
          if (!inputArg) {
            throw new Error(
              `Could not find argument ${name} for type ${this.getTypeName(
                instruction.field.type,
              )}`,
            )
          }

          variableDefinitions.push({
            kind: Kind.VARIABLE_DEFINITION,
            variable: {
              kind: Kind.VARIABLE,
              name: {
                kind: Kind.NAME,
                value: variableName,
              },
            },
            type: inputArg.astNode.type,
          })

          args.push({
            kind: Kind.ARGUMENT,
            name: {
              kind: Kind.NAME,
              value: name,
            },
            value: {
              kind: Kind.VARIABLE,
              name: {
                kind: 'Name',
                value: variableName,
              },
            },
          })
        })
      }

      const node = {
        kind: Kind.FIELD,
        name: {
          kind: Kind.NAME,
          value: instruction.fieldName,
        },
        arguments: args,
        directives: [],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [] as any[],
        },
      }

      const type = this.getDeepType(instruction.field.type)
      if (
        index === instructions.length - 1 &&
        type instanceof GraphQLObjectType
      ) {
        if (instruction.fragment) {
          if (typeof instruction.fragment === 'string') {
            instruction.fragment = gql`
              ${instruction.fragment}
            `
          }
          node.selectionSet = instruction.fragment.definitions[0].selectionSet
        } else {
          node.selectionSet.selections = Object.entries(type.getFields())
            .filter(([_, field]: any) => {
              const fieldType = this.getDeepType(field.type)
              return fieldType instanceof GraphQLScalarType
            })
            .map(([fieldName]) => ({
              kind: Kind.FIELD,
              name: {
                kind: Kind.NAME,
                value: fieldName,
              },
              arguments: [],
              directives: [],
            }))
        }
      }

      if (acc) {
        node.selectionSet.selections.push(acc)
      }

      return node
    }, null)

    return {
      ast: { ...ast, variableDefinitions },
      variables,
    }
  }

  buildMethods() {
    this.types = this.getORMTypes()
    Object.assign(this, this.types.Query)
    Object.assign(this, this.types.Mutation)
    this.$subscribe = this.types.Subscription
  }

  getORMTypes() {
    const typeMap = this.schema.getTypeMap()
    const types = Object.entries(typeMap)
      .map(([name, type]) => {
        let value = {
          then: this.then,
          catch: this.catch,
          [Symbol.toStringTag]: 'Promise',
        }
        if (type instanceof GraphQLObjectType) {
          value = {
            ...value,
            ...Object.entries(type.getFields())
              .map(([fieldName, field]) => {
                return {
                  key: fieldName,
                  value: (args, arg2, fragment) => {
                    const id = typeof args === 'number' ? args : ++instructionId

                    let realArgs = typeof args === 'number' ? arg2 : args
                    this.currentInstructions[id] =
                      this.currentInstructions[id] || []
                    if (this.currentInstructions[id].length === 0) {
                      if (name === 'Mutation') {
                        if (fieldName.startsWith('create')) {
                          realArgs = { data: realArgs }
                        }
                        if (fieldName.startsWith('delete')) {
                          realArgs = { where: realArgs }
                        }
                      } else if (name === 'Query') {
                        if (field.args.length === 1) {
                          realArgs = { where: realArgs }
                        }
                      }
                    }
                    this.currentInstructions[id].push({
                      fieldName,
                      args: realArgs,
                      field,
                      typeName: type.name,
                      fragment: typeof args === 'number' ? fragment : arg2,
                    })
                    const typeName = this.getTypeName(field.type)

                    // this is black magic. what we do here: bind both .then, .catch and all resolvers to `id`
                    return mapValues(this.types[typeName], (key, value) => {
                      if (typeof value === 'function') {
                        return value.bind(this, id)
                      }
                      return value
                    })
                  },
                }
              })
              .reduce(reduceKeyValue, {}),
          }
        }

        return {
          key: name,
          value,
        }
      })
      .reduce(reduceKeyValue, {})

    return types
  }

  getTypeName(type): string {
    if (type.ofType) {
      return this.getDeepType(type.ofType)
    }
    return type.name
  }

  getDeepType(type) {
    if (type.ofType) {
      return this.getDeepType(type.ofType)
    }

    return type
  }

  private buildExists(): Exists {
    const queryType = this.schema.getQueryType()
    if (!queryType) {
      return {}
    }
    if (queryType) {
      const types = getTypesAndWhere(queryType)

      return types.reduce((acc, { type, pluralFieldName }) => {
        const firstLetterLowercaseTypeName =
          type[0].toLowerCase() + type.slice(1)
        return {
          ...acc,
          [firstLetterLowercaseTypeName]: args => {
            // TODO: when the fragment api is there, only add one field
            return this[pluralFieldName]({ where: args }).then(
              res => res.length > 0,
            )
          },
        }
      }, {})
    }

    return {}
  }
}

const reduceKeyValue = (acc, curr) => ({
  ...acc,
  [curr.key]: curr.value,
})
