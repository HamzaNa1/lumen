-- Added in place rather than by rebuilding catalog_items, which would drop its triggers.
ALTER TABLE `catalog_items` ADD `index_number_end` integer CONSTRAINT "catalog_items_index_end_chk" CHECK("index_number_end" is null or ("index_number" is not null and "index_number_end" > "index_number"));
