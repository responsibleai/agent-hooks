// Copyright (c) Microsoft. All rights reserved.

import { schemaPaths } from "./_route.ts";

export { GET } from "./_route.ts";
export const getStaticPaths = () => schemaPaths(".json");
