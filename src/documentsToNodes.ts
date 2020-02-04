import PrismicDOM from 'prismic-dom'
import pascalcase from 'pascalcase'
import { Document as PrismicDocument } from 'prismic-javascript/d.ts/documents'
import pick from 'lodash.pick'
import omit from 'lodash.omit'
import { mapObjValsP, buildSchemaTypeName } from './utils'
import {
  DocumentsToNodesEnvironment,
  TypePath,
  GraphQLType,
  StructuredTextField,
  LinkField,
  AlternateLanguagesField,
  LinkFieldType,
  LinkResolver,
  DocumentNodeInput,
  GroupField,
  SlicesField,
  SliceNodeInput,
  Field,
  NormalizedField,
  NormalizedAlternateLanguagesField,
  ImageField,
} from './types'

const IMAGE_FIELD_KEYS = ['alt', 'copyright', 'dimensions', 'url'] as const

const getTypeForPath = (
  path: TypePath['path'],
  typePaths: TypePath[],
): GraphQLType | string | undefined => {
  const stringifiedPath = JSON.stringify(path)
  const def = typePaths.find(x => JSON.stringify(x.path) === stringifiedPath)

  if (!def) return
  if (/^\[.*GroupType\]$/.test(def.type)) return GraphQLType.Group
  if (/^\[.*SlicesType\]$/.test(def.type)) return GraphQLType.Slices

  return def.type
}

const normalizeField = async (
  apiId: string,
  field: Field,
  path: TypePath['path'],
  doc: PrismicDocument,
  env: DocumentsToNodesEnvironment,
): Promise<NormalizedField> => {
  const {
    createNodeId,
    createNode,
    createContentDigest,
    typePaths,
    normalizeStructuredTextField,
    normalizeLinkField,
    normalizeImageField,
    normalizeSlicesField,
  } = env

  const type = getTypeForPath([...path, apiId], typePaths)

  switch (type) {
    case GraphQLType.Image: {
      const baseObj: ImageField = pick(field as ImageField, IMAGE_FIELD_KEYS)
      const thumbsObj = omit(field as ImageField, IMAGE_FIELD_KEYS) as {
        [key: string]: ImageField
      }

      const base = await normalizeImageField(apiId, baseObj, path, doc, env)
      const thumbs = await mapObjValsP(
        async thumb => await normalizeImageField(apiId, thumb, path, doc, env),
        thumbsObj,
      )

      return { ...base, thumbnails: thumbs }
    }

    case GraphQLType.StructuredText: {
      return await normalizeStructuredTextField(
        apiId,
        field as StructuredTextField,
        path,
        doc,
        env,
      )
    }

    case GraphQLType.Link: {
      return await normalizeLinkField(apiId, field as LinkField, path, doc, env)
    }

    case GraphQLType.Group: {
      return await normalizeObjs(
        field as GroupField,
        [...path, apiId],
        doc,
        env,
      )
    }

    case GraphQLType.Slices: {
      const sliceNodeIds = await Promise.all(
        (field as SlicesField).map(async (slice, index) => {
          const sliceNodeId = createNodeId(
            `${doc.type} ${doc.id} ${apiId} ${index}`,
          )

          const normalizedPrimary = await normalizeObj(
            slice.primary,
            [...path, apiId, slice.slice_type, 'primary'],
            doc,
            env,
          )

          const normalizedItems = await normalizeObjs(
            slice.items,
            [...path, apiId, slice.slice_type, 'items'],
            doc,
            env,
          )

          const node: SliceNodeInput = {
            id: sliceNodeId,
            primary: normalizedPrimary,
            items: normalizedItems,
            internal: {
              type: pascalcase(
                `Prismic ${doc.type} ${apiId} ${slice.slice_type}`,
              ),
              contentDigest: createContentDigest(slice),
            },
          }

          createNode(node)

          return node.id
        }),
      )

      return await normalizeSlicesField(
        apiId,
        sliceNodeIds,
        [...path, apiId],
        doc,
        env,
      )
    }

    // This field type is not an actual Prismic type and was assigned manually
    // in `schemasToTypeDefs.ts`.
    case GraphQLType.AlternateLanguages: {
      // Treat the array of alternate language documents as a list of link
      // fields. We need to force the link type to a Document since it is not
      // there by default.
      return await Promise.all(
        (field as AlternateLanguagesField).map(
          async item =>
            await normalizeLinkField(
              apiId,
              {
                ...item,
                link_type: LinkFieldType.Document,
              },
              path,
              doc,
              env,
            ),
        ),
      )
    }

    default: {
      return field
    }
  }
}

const normalizeObj = async (
  obj: { [key: string]: Field } = {},
  path: TypePath['path'],
  doc: PrismicDocument,
  env: DocumentsToNodesEnvironment,
): Promise<{ [key: string]: NormalizedField }> =>
  mapObjValsP(
    (field, fieldApiId) => normalizeField(fieldApiId, field, path, doc, env),
    obj,
  )

const normalizeObjs = async (
  objs: { [key: string]: Field }[] = [],
  path: TypePath['path'],
  doc: PrismicDocument,
  env: DocumentsToNodesEnvironment,
) => await Promise.all(objs.map(obj => normalizeObj(obj, path, doc, env)))

const documentToNodes = async (
  doc: PrismicDocument,
  env: DocumentsToNodesEnvironment,
) => {
  const { createNode, createContentDigest, createNodeId, pluginOptions } = env
  const { linkResolver } = pluginOptions

  let linkResolverForDoc: LinkResolver | undefined = undefined
  if (linkResolver) linkResolverForDoc = linkResolver({ node: doc })

  const docNodeId = createNodeId(`${doc.type} ${doc.id}`)
  const docUrl = PrismicDOM.Link.url(doc, linkResolverForDoc)

  const normalizedData = await normalizeObj(
    doc.data,
    [doc.type, 'data'],
    doc,
    env,
  )
  const normalizedAlernativeLanguages = (await normalizeField(
    'alternate_languages',
    (doc.alternate_languages as unknown) as AlternateLanguagesField,
    [doc.type],
    doc,
    env,
  )) as NormalizedAlternateLanguagesField

  const node: DocumentNodeInput = {
    ...doc,
    id: docNodeId,
    prismicId: doc.id,
    data: normalizedData,
    dataString: JSON.stringify(doc.data),
    dataRaw: doc.data,
    alternate_languages: normalizedAlernativeLanguages,
    url: docUrl,
    internal: {
      type: buildSchemaTypeName(doc.type),
      contentDigest: createContentDigest(doc),
    },
  }

  createNode(node)
}

export const documentsToNodes = async (
  docs: PrismicDocument[],
  env: DocumentsToNodesEnvironment,
) => {
  await Promise.all(docs.map(doc => documentToNodes(doc, env)))
}
