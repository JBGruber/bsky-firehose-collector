export type DatabaseSchema = {
  post: Post
  engagement: Engagement
  label: Label
  sub_state: SubState
}

export type Post = {
  uri: string
  cid: string
  indexedAt: string
  createdAt: string
  deletedAt?: string
  author: string
  text: string
  rootUri: string
  rootCid: string
  linkUrl: string
  linkTitle: string
  linkDescription: string
  likes_count?: number
  repost_count?: number
  comments_count?: number
}

export type Engagement = {
  uri: string
  cid: string
  subjectUri: string
  subjectCid: string
  type: number
  indexedAt: string
  createdAt: string
  author: string
}

export type Label = {
  src: string
  uri: string
  cid: string
  val: string
  neg: boolean
  cts: string
  indexedAt: string
}

export type SubState = {
  service: string
  cursor: bigint
}
